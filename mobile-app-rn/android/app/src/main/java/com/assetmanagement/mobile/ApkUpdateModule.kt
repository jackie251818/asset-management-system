package com.assetmanagement.mobile

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * 应用内自更新原生模块。
 *
 * JS 侧调用链：
 *   getVersion()              -> 读当前 versionCode/versionName
 *   downloadApk(url, sha256)  -> 后台线程下载到外部缓存 updates/update.apk（先写 .download），
 *                                下载过程中发射 ApkUpdateProgress 事件，落盘后做 SHA-256 校验
 *   canInstallPackages()      -> Android 8+ 是否拥有"安装未知应用"授权
 *   openInstallPermissionSettings() -> 跳转系统授权页
 *   installApk(path)          -> 通过 FileProvider 调起系统包安装器（未授权时 reject E_NO_PERMISSION）
 */
class ApkUpdateModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "ApkUpdate"
        private const val EVENT_PROGRESS = "ApkUpdateProgress"
        private const val DIR_NAME = "updates"
        private const val APK_NAME = "update.apk"
        private const val TMP_NAME = "update.apk.download"
    }

    // 下载任务串行执行，避免并发写同一个文件
    private val executor = Executors.newSingleThreadExecutor()

    override fun getName(): String = "ApkUpdate"

    @ReactMethod
    fun getVersion(promise: Promise) {
        try {
            val pm = reactApplicationContext.packageManager
            val info = pm.getPackageInfo(reactApplicationContext.packageName, 0)
            val code = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                info.longVersionCode.toInt()
            } else {
                @Suppress("DEPRECATION")
                info.versionCode
            }
            val map = Arguments.createMap()
            map.putString("versionName", info.versionName ?: "0.0.0")
            map.putInt("versionCode", code)
            promise.resolve(map)
        } catch (e: Exception) {
            promise.reject("E_VERSION", "读取版本失败: ${e.message}")
        }
    }

    @ReactMethod
    fun canInstallPackages(promise: Promise) {
        promise.resolve(canInstall())
    }

    @ReactMethod
    fun openInstallPermissionSettings(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val intent = Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:${reactApplicationContext.packageName}")
                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                reactApplicationContext.startActivity(intent)
            }
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("E_INTENT", "无法打开授权设置: ${e.message}")
        }
    }

    @ReactMethod
    fun installApk(path: String, promise: Promise) {
        try {
            if (!canInstall()) {
                promise.reject("E_NO_PERMISSION", "尚未授予安装未知应用权限")
                return
            }
            val file = File(path)
            if (!file.exists()) {
                promise.reject("E_NO_FILE", "安装包不存在: $path")
                return
            }
            val authority = "${reactApplicationContext.packageName}.fileprovider"
            val uri = FileProvider.getUriForFile(reactApplicationContext, authority, file)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            reactApplicationContext.startActivity(intent)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("E_INSTALL", "调起安装器失败: ${e.message}")
        }
    }

    @ReactMethod
    fun downloadApk(urlStr: String, expectedSha256: String?, promise: Promise) {
        executor.execute {
            var conn: HttpURLConnection? = null
            var tmp: File? = null
            try {
                val baseDir = reactApplicationContext.externalCacheDir ?: reactApplicationContext.cacheDir
                val dir = File(baseDir, DIR_NAME).apply { if (!exists()) mkdirs() }
                val target = File(dir, APK_NAME)
                tmp = File(dir, TMP_NAME)

                conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 15_000
                    readTimeout = 60_000
                    instanceFollowRedirects = true
                    setRequestProperty("User-Agent", "AssetMgmt-Android-Updater")
                    connect()
                }
                val code = conn.responseCode
                if (code !in 200..299) {
                    throw RuntimeException("HTTP $code")
                }

                val total = conn.contentLengthLong // chunked 时为 -1
                val digest = MessageDigest.getInstance("SHA-256")
                conn.inputStream.use { input ->
                    tmp.outputStream().use { out ->
                        val buf = ByteArray(64 * 1024)
                        var received = 0L
                        var lastEmit = 0L
                        while (true) {
                            val n = input.read(buf)
                            if (n <= 0) break
                            out.write(buf, 0, n)
                            digest.update(buf, 0, n)
                            received += n
                            val now = System.currentTimeMillis()
                            // 限频 ~5fps，避免跨桥事件风暴
                            if (now - lastEmit >= 200) {
                                lastEmit = now
                                emitProgress(received, total)
                            }
                        }
                        out.flush()
                    }
                }
                // 确保进度条收尾到 100%
                emitProgress(if (total > 0) total else tmp.length(), total)

                val actualSha = digest.digest().joinToString("") { "%02x".format(it) }
                val expect = expectedSha256?.trim()?.lowercase().orEmpty()
                if (expect.isNotEmpty() && expect != actualSha) {
                    tmp.delete()
                    promise.reject("E_HASH", "安装包校验失败（SHA256 不匹配），已中止更新")
                    return@execute
                }

                if (target.exists() && !target.delete()) {
                    Log.w(TAG, "旧 APK 删除失败，将尝试覆盖复制")
                }
                if (!tmp.renameTo(target)) {
                    // 个别 ROM 上同目录 rename 失败时回退到复制
                    tmp.copyTo(target, overwrite = true)
                    tmp.delete()
                }

                val res = Arguments.createMap()
                res.putString("path", target.absolutePath)
                res.putString("sha256", actualSha)
                promise.resolve(res)
            } catch (e: Exception) {
                Log.e(TAG, "download APK failed", e)
                tmp?.takeIf { it.exists() }?.delete()
                promise.reject("E_DOWNLOAD", "下载更新失败: ${e.message ?: "网络错误"}")
            } finally {
                conn?.disconnect()
            }
        }
    }

    private fun canInstall(): Boolean {
        // Android 8.0 (API 26) 起需要"安装未知应用"运行时授权
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true
        return reactApplicationContext.packageManager.canRequestPackageInstalls()
    }

    private fun emitProgress(received: Long, total: Long) {
        try {
            val map: WritableMap = Arguments.createMap()
            map.putDouble("received", received.toDouble())
            map.putDouble("total", total.toDouble())
            map.putInt("percent", if (total > 0) (received * 100 / total).toInt() else -1)
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(EVENT_PROGRESS, map)
        } catch (e: Exception) {
            // JS 上下文未就绪时忽略
        }
    }
}

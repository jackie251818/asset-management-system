import { useSettingsStore } from '../store/settingsStore';
import { useAuthStore } from '../store/authStore';

class ApiClient {
  private get baseUrl(): string {
    return useSettingsStore.getState().serverUrl || 'http://192.168.40.247';
  }

  private getHeaders(): Record<string, string> {
    const token = useAuthStore.getState().token;
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let resp: Response;
    try {
      resp = await fetch(url, {
        ...options,
        headers: { ...this.getHeaders(), ...(options.headers as Record<string, string>) },
      });
    } catch (e) {
      throw new Error('网络连接失败，请检查服务器地址');
    }

    if (resp.status === 401) {
      useAuthStore.getState().logout();
      throw new Error('登录已过期，请重新登录');
    }

    const text = await resp.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // 非 JSON 响应
    }

    if (!resp.ok) {
      throw new Error(data?.message || data?.error || `HTTP ${resp.status}`);
    }

    // 兼容两种响应包装：{ success:true/false, data } 或 { code:0/非0, message, data }
    if (data && typeof data === 'object' && ('success' in data || 'code' in data)) {
      const okFlag = 'success' in data
        ? data.success !== false
        : data.code === 0 || data.code === 200;
      if (!okFlag) {
        throw new Error(data.message || data.error || `请求失败(code:${data.code})`);
      }
      return data.data !== undefined ? data.data : data;
    }

    return data as T;
  }

  get<T>(path: string) {
    return this.request<T>(path);
  }
  post<T>(path: string, body?: any) {
    return this.request<T>(path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined });
  }
  put<T>(path: string, body?: any) {
    return this.request<T>(path, { method: 'PUT', body: body !== undefined ? JSON.stringify(body) : undefined });
  }
  delete<T>(path: string) {
    return this.request<T>(path, { method: 'DELETE' });
  }
}

export const api = new ApiClient();

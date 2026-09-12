import { useEffect, useState, useCallback } from 'react';
import { Camera, useCameraDevice, useCodeScanner } from 'react-native-vision-camera';

export function useScanner(onScan: (code: string) => void) {
  const [hasPermission, setHasPermission] = useState(false);
  const [isScanning, setIsScanning] = useState(true);
  // v4: useCameraDevice(position) 返回单个设备或 undefined
  const device = useCameraDevice('back');

  useEffect(() => {
    (async () => {
      const status = await Camera.requestCameraPermission();
      setHasPermission(status === 'granted');
    })();
  }, []);

  // 每次识别都交给上层；上层会立即暂停相机，所以无需防抖
  const handleCodes = useCallback(
    (codes: { value?: string }[]) => {
      if (codes.length === 0) return;
      const code = codes[0]?.value;
      if (code) onScan(code);
    },
    [onScan],
  );

  // v4 原生 MLKit 扫码（无需 frame processor / worklets）
  const codeScanner = useCodeScanner({
    codeTypes: ['qr', 'code-128'],
    onCodeScanned: handleCodes,
  });

  return { hasPermission, device, codeScanner, isScanning, setIsScanning };
}

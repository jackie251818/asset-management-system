/**
 * 自更新入口：App 启动 6 秒后静默检查一次（与电脑端 EXE 行为一致），并全局挂载更新弹窗。
 * 手动检查入口在"我的"页（SettingsScreen）。
 */
import React, { useEffect, useRef } from 'react';
import UpdateModal from './UpdateModal';
import { useUpdateStore } from '../store/updateStore';
import { apkUpdateSupported } from '../utils/apkUpdate';

const AUTO_CHECK_DELAY_MS = 6_000;

export default function UpdateGate() {
  const check = useUpdateStore((s) => s.check);
  const checkedRef = useRef(false);

  useEffect(() => {
    if (!apkUpdateSupported) return;
    const timer = setTimeout(() => {
      if (checkedRef.current) return;
      checkedRef.current = true;
      // 静默检查：失败/无更新均不打扰用户
      check(false);
    }, AUTO_CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [check]);

  return <UpdateModal />;
}

#!/usr/bin/env bash
# 一键回退脚本（t1 安全准备）
# 用法: bash hub/scripts/rollback.sh
# 回退到 git HEAD 1821316，恢复数据库备份，检查 adb 保活
set -euo pipefail

REPO_ROOT="/home/yan/.openclaw/workspace-devin/agent-hub"
TARGET_COMMIT="1821316"
DB_DIR="${REPO_ROOT}/hub/data"
BACKUP_DIR="${DB_DIR}/backups"

echo "=== 1. git reset --hard ${TARGET_COMMIT} ==="
cd "${REPO_ROOT}"
CURRENT_HEAD=$(git rev-parse --short HEAD)
echo "当前 HEAD: ${CURRENT_HEAD}"
if [ "${CURRENT_HEAD}" = "${TARGET_COMMIT}" ]; then
  echo "已在目标 commit，跳过 reset"
else
  git reset --hard "${TARGET_COMMIT}"
  echo "已回退到 ${TARGET_COMMIT}"
fi

echo ""
echo "=== 2. 恢复数据库备份 ==="
LATEST_DB=$(ls -t "${BACKUP_DIR}"/hub.db.bak.* 2>/dev/null | head -1)
if [ -z "${LATEST_DB}" ]; then
  echo "警告: 未找到数据库备份文件"
else
  echo "恢复: ${LATEST_DB} -> ${DB_DIR}/hub.db"
  cp "${LATEST_DB}" "${DB_DIR}/hub.db"
  if [ -f "${BACKUP_DIR}/hub.db-wal" ]; then
    cp "${BACKUP_DIR}/hub.db-wal" "${DB_DIR}/hub.db-wal"
  fi
  if [ -f "${BACKUP_DIR}/hub.db-shm" ]; then
    cp "${BACKUP_DIR}/hub.db-shm" "${DB_DIR}/hub.db-shm"
  fi
  echo "数据库已恢复"
fi

echo ""
echo "=== 3. adb 保活检查 ==="
if command -v adb >/dev/null 2>&1; then
  DEVICES=$(adb devices | grep -c "device$" || true)
  if [ "${DEVICES}" -ge 1 ]; then
    echo "adb 设备在线: ${DEVICES} 台"
    adb devices
  else
    echo "警告: 无 adb 设备连接"
  fi
else
  echo "adb 未安装，跳过"
fi

echo ""
echo "=== 回退完成 ==="
echo "如需生效，请重启 Hub 进程"

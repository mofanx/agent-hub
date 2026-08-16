import { useHubStore } from "../hub/store";
import type { ConnProfile } from "../hub/types";

function profileKey(p: ConnProfile) {
  return p.address;
}

export function HubDrawer() {
  const store = useHubStore();
  if (!store.drawerOpen) return null;

  const currentKey = store.currentProfile ? profileKey(store.currentProfile) : null;
  const connected = !!store.client?.isConnected;

  const onSelect = (p: ConnProfile) => {
    store.closeDrawer();
    store.switchProfile(p);
  };

  const onDisconnect = () => {
    store.closeDrawer();
    store.disconnect();
  };

  const onOpenConfig = () => {
    store.closeDrawer();
    useHubStore.setState({ screen: "connect" });
  };

  return (
    <div className="drawer-overlay" onClick={store.closeDrawer}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <h2>Hub 列表</h2>
          <button className="secondary tiny" onClick={store.closeDrawer}>
            ✕
          </button>
        </div>

        <div className="drawer-status">
          {store.currentProfile ? (
            <span className="title-wrap">
              <span
                className="dot"
                style={{ color: connected ? "#2ecc71" : "#f1c40f" }}
              >
                ●
              </span>
              <span>{store.currentProfile.name}</span>
              <span className="subtitle">
                {store.currentProfile.address}
              </span>
            </span>
          ) : (
            <span className="subtitle">未连接</span>
          )}
        </div>

        <div className="drawer-list">
          {store.profiles.length === 0 && (
            <div className="drawer-empty">暂无保存的 Hub</div>
          )}
          {store.profiles.map((p) => {
            const active = currentKey === profileKey(p);
            return (
              <div
                key={profileKey(p)}
                className={`drawer-item ${active ? "active" : ""}`}
                onClick={() => onSelect(p)}
              >
                <div className="title-wrap">
                  <span className="title">{p.name}</span>
                  <span className="subtitle">
                    {p.address}
                  </span>
                </div>
                {active && (
                  <span
                    className="dot"
                    style={{ color: connected ? "#2ecc71" : "#f1c40f" }}
                  >
                    ●
                  </span>
                )}
              </div>
            );
          })}
        </div>

        <div className="drawer-footer">
          <button onClick={onOpenConfig}>＋ 添加 / 管理</button>
          {store.client && (
            <button className="danger" onClick={onDisconnect}>
              断开当前
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}

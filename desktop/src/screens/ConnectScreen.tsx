import { useEffect, useState } from "react";
import { useHubStore } from "../hub/store";
import type { ConnProfile } from "../hub/types";

export function ConnectScreen() {
  const store = useHubStore();
  const [host, setHost] = useState("");
  const [port, setPort] = useState("8787");
  const [token, setToken] = useState("dev-token");

  useEffect(() => {
    const last = store.profiles[store.profiles.length - 1];
    if (last) {
      setHost(last.address);
      setPort(last.port);
      setToken(last.token);
    }
  }, [store.profiles]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    store.connect(host, port, token);
  };

  const fill = (p: ConnProfile) => {
    setHost(p.address);
    setPort(p.port);
    setToken(p.token);
  };

  const isRemote = (p: ConnProfile) =>
    p.address.startsWith("wss://") || p.address.startsWith("https://");

  return (
    <div className="card connect-card">
      <h2>连接 Hub</h2>
      <form onSubmit={onSubmit}>
        <div className="form-row">
          <label>地址</label>
          <input
            value={host}
            onChange={(e) => setHost(e.currentTarget.value)}
            placeholder="IP 或 ws(s)://地址"
            required
          />
        </div>
        <div className="form-row">
          <label>端口</label>
          <input
            value={port}
            onChange={(e) => setPort(e.currentTarget.value)}
            placeholder="8787"
          />
        </div>
        <div className="form-row">
          <label>Token</label>
          <input
            value={token}
            onChange={(e) => setToken(e.currentTarget.value)}
            placeholder="HUB_TOKEN"
            required
          />
        </div>
        {store.connectError && <div className="error">{store.connectError}</div>}
        <div className="form-row" style={{ justifyContent: "flex-end" }}>
          <button type="submit" disabled={store.connecting}>
            {store.connecting ? "连接中..." : "连接"}
          </button>
        </div>
      </form>

      {store.profiles.length > 0 && (
        <>
          <h3>已保存档案</h3>
          <div className="list">
            {store.profiles.map((p) => (
              <div key={profileKey(p)} className="list-item profile-card" onClick={() => fill(p)}>
                <span className="title">
                  {isRemote(p) ? "🌐" : "📡"} {p.name}
                </span>
                <span className="subtitle">
                  {isRemote(p) ? "远程 (wss)" : "局域网"} · {p.address}:{p.port}
                </span>
                <button
                  className="danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    store.deleteProfile(p);
                  }}
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function profileKey(p: ConnProfile) {
  return `${p.address}\u0001${p.port}`;
}

import { useEffect, useMemo, useState } from "react";
import { useHubStore } from "../hub/store";
import type { ConnProfile } from "../hub/types";

function profileKey(p: ConnProfile) {
  return `${p.address}\u0001${p.port}`;
}

function isRemote(p: ConnProfile) {
  return p.address.startsWith("wss://") || p.address.startsWith("https://");
}

export function HubConfigScreen() {
  const store = useHubStore();
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("8787");
  const [token, setToken] = useState("dev-token");
  const [editing, setEditing] = useState<ConnProfile | null>(null);

  const last = useMemo(() => {
    const p = store.currentProfile;
    if (p) return p;
    return store.profiles[store.profiles.length - 1];
  }, [store.currentProfile, store.profiles]);

  useEffect(() => {
    if (last) {
      setName(last.name);
      setHost(last.address);
      setPort(last.port);
      setToken(last.token);
      setEditing(null);
    }
  }, [last]);

  const reset = () => {
    setName("");
    setHost("");
    setPort("8787");
    setToken("dev-token");
    setEditing(null);
  };

  const fill = (p: ConnProfile, edit = false) => {
    setName(p.name);
    setHost(p.address);
    setPort(p.port);
    setToken(p.token);
    setEditing(edit ? p : null);
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (editing && profileKey(editing) !== `${host}\u0001${port}`) {
      store.deleteProfile(editing);
    }
    store.connect(host, port, token, trimmed);
  };

  const onDelete = (p: ConnProfile) => {
    store.deleteProfile(p);
    if (editing && profileKey(editing) === profileKey(p)) reset();
  };

  return (
    <div className="card connect-card">
      <h2>{editing ? "编辑 Hub 配置" : "添加 / 连接 Hub"}</h2>
      <form onSubmit={onSubmit}>
        <div className="form-row">
          <label>名称</label>
          <input
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            placeholder="例如 本机 / 公网 VPS"
            required
          />
        </div>
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
          {editing && (
            <button type="button" className="secondary" onClick={reset}>
              取消编辑
            </button>
          )}
          <button type="submit" disabled={store.connecting}>
            {store.connecting ? "连接中..." : editing ? "保存并连接" : "添加并连接"}
          </button>
        </div>
      </form>

      {store.profiles.length > 0 && (
        <>
          <h3>已保存的配置</h3>
          <div className="list">
            {store.profiles.map((p) => {
              const active = store.currentProfile && profileKey(store.currentProfile) === profileKey(p);
              return (
                <div
                  key={profileKey(p)}
                  className={`list-item profile-card ${active ? "selected" : ""}`}
                >
                  <span className="title">
                    {isRemote(p) ? "🌐" : "📡"} {p.name}
                  </span>
                  <span className="subtitle">
                    {isRemote(p) ? "远程 (wss)" : "局域网"} · {p.address}:{p.port}
                  </span>
                  <div className="actions" onClick={(e) => e.stopPropagation()}>
                    <button className="tiny" onClick={() => fill(p, true)}>
                      编辑
                    </button>
                    <button
                      className="tiny"
                      onClick={() => store.switchProfile(p)}
                      disabled={!!active}
                    >
                      连接
                    </button>
                    <button className="danger tiny" onClick={() => onDelete(p)}>
                      删除
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

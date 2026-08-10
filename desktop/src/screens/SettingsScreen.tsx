import { useState } from "react";
import { useHubStore } from "../hub/store";
import type { ConnectionInfo, RoleInfo } from "../hub/types";

export function SettingsScreen() {
  const store = useHubStore();
  const [tab, setTab] = useState<"general" | "connections" | "roles">("general");

  return (
    <div className="settings-screen">
      <div className="tabs">
        {(["general", "connections", "roles"] as const).map((t) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {tabLabel(t)}
          </button>
        ))}
        <button onClick={() => void store.refreshAll()}>刷新</button>
      </div>

      {tab === "general" && <GeneralSettings />}
      {tab === "connections" && <ConnectionsSettings />}
      {tab === "roles" && <RolesSettings />}

      <div className="card" style={{ marginTop: "auto" }}>
        <button className="danger" onClick={store.disconnect}>
          断开连接并返回
        </button>
      </div>
    </div>
  );
}

function tabLabel(t: "general" | "connections" | "roles") {
  return { general: "通用", connections: "Agent 来源", roles: "角色" }[t];
}

function GeneralSettings() {
  const { themeMode, lang, toggleBypass } = useHubStore();
  return (
    <div className="settings-section">
      <div className="card">
        <h3>主题</h3>
        <div className="form-row">
          {(["system", "light", "dark"] as const).map((m) => (
            <button
              key={m}
              className={themeMode === m ? "active" : "secondary"}
              onClick={() => useHubStore.getState().updateThemeMode(m)}
            >
              {m === "system" ? "跟随系统" : m === "light" ? "浅色" : "深色"}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>语言</h3>
        <div className="form-row">
          {[
            { key: "zh", label: "中文" },
            { key: "en", label: "English" },
          ].map(({ key, label }) => (
            <button
              key={key}
              className={lang === key ? "active" : "secondary"}
              onClick={() => useHubStore.getState().updateLang(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>权限绕过</h3>
        <p className="subtitle">开启后自动审批工具调用请求。</p>
        <div className="form-row">
          <button onClick={() => toggleBypass("on")}>开启</button>
          <button className="secondary" onClick={() => toggleBypass("off")}>
            关闭
          </button>
          <button onClick={() => toggleBypass()}>切换</button>
        </div>
      </div>
    </div>
  );
}

function ConnectionsSettings() {
  const store = useHubStore();
  const [form, setForm] = useState<Record<string, string>>({
    agent: "devin",
    local: "false",
  });
  const [showAdd, setShowAdd] = useState(false);

  const submit = () => {
    const { name, agent, address, cwd, token, local } = form;
    if (!name || !agent) return;
    void store.createConnection(name, agent, address || "", cwd || "", token || "", local === "true");
    setShowAdd(false);
    setForm({ agent: "devin", local: "false" });
  };

  return (
    <div className="settings-section">
      {store.connections.map((c) => (
        <ConnectionCard key={c.id} c={c} />
      ))}

      {!showAdd ? (
        <button onClick={() => setShowAdd(true)}>＋ 添加 Agent 来源</button>
      ) : (
        <div className="card">
          <h3>添加 Agent 来源</h3>
          <FormRow label="名称">
            <input value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} />
          </FormRow>
          <FormRow label="类型">
            <select value={form.agent ?? "devin"} onChange={(e) => setForm({ ...form, agent: e.currentTarget.value })}>
              {["devin", "claude", "codex", "opencode"].map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </FormRow>
          <FormRow label="地址">
            <input value={form.address ?? ""} onChange={(e) => setForm({ ...form, address: e.currentTarget.value })} />
          </FormRow>
          <FormRow label="工作目录">
            <input value={form.cwd ?? ""} onChange={(e) => setForm({ ...form, cwd: e.currentTarget.value })} />
          </FormRow>
          <FormRow label="Token">
            <input value={form.token ?? ""} onChange={(e) => setForm({ ...form, token: e.currentTarget.value })} />
          </FormRow>
          <FormRow label="本地启动">
            <select value={form.local ?? "false"} onChange={(e) => setForm({ ...form, local: e.currentTarget.value })}>
              <option value="false">否</option>
              <option value="true">是</option>
            </select>
          </FormRow>
          <div className="form-row" style={{ justifyContent: "flex-end" }}>
            <button className="secondary" onClick={() => setShowAdd(false)}>
              取消
            </button>
            <button onClick={submit}>创建</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ConnectionCard({ c }: { c: ConnectionInfo }) {
  const store = useHubStore();
  const statusColor = c.error ? "#ef4444" : c.local ? "#3b82f6" : c.online ? "#22c55e" : "#9ca3af";
  const statusLabel = c.error ? "启动失败" : c.local ? "本机" : c.online ? "在线" : "离线";
  return (
    <div className="card connection-card" style={{ borderLeft: `4px solid ${statusColor}` }}>
      <div className="form-row" style={{ justifyContent: "space-between" }}>
        <span className="title" style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
          <span className="dot" style={{ color: statusColor }}>●</span>
          {c.name} · {c.agent} · {statusLabel}
        </span>
        <button className="danger" onClick={() => void store.deleteConnection(c.id)}>
          删除
        </button>
      </div>
      <div className="subtitle">
        {c.local ? "本地直接启动" : `Token: ${c.token}`}
        {c.address && ` · ${c.address}`}
        {c.cwd && ` · ${c.cwd}`}
      </div>
      {c.error && <div className="error">启动失败: {c.error}</div>}
      {!c.local && (
        <button className="secondary" onClick={() => void navigator.clipboard.writeText(c.token)}>
          复制 Token
        </button>
      )}
    </div>
  );
}

function RolesSettings() {
  const store = useHubStore();
  const [form, setForm] = useState<Record<string, string>>({});
  const [showAdd, setShowAdd] = useState(false);

  const submit = () => {
    const { name, persona, cwd, connectionId } = form;
    if (!name || !persona) return;
    void store.createRole(name, persona, cwd || "", connectionId || undefined);
    setShowAdd(false);
    setForm({});
  };

  return (
    <div className="settings-section">
      {store.roles.map((r) => (
        <RoleCard key={r.id} r={r} />
      ))}

      {!showAdd ? (
        <button onClick={() => setShowAdd(true)}>＋ 添加角色</button>
      ) : (
        <div className="card">
          <h3>添加角色</h3>
          <FormRow label="名称">
            <input value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} />
          </FormRow>
          <FormRow label="人设">
            <textarea
              value={form.persona ?? ""}
              onChange={(e) => setForm({ ...form, persona: e.currentTarget.value })}
              rows={4}
            />
          </FormRow>
          <FormRow label="工作目录">
            <input value={form.cwd ?? ""} onChange={(e) => setForm({ ...form, cwd: e.currentTarget.value })} />
          </FormRow>
          <FormRow label="连接">
            <select
              value={form.connectionId ?? ""}
              onChange={(e) => setForm({ ...form, connectionId: e.currentTarget.value })}
            >
              <option value="">可选</option>
              {store.connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </FormRow>
          <div className="form-row" style={{ justifyContent: "flex-end" }}>
            <button className="secondary" onClick={() => setShowAdd(false)}>
              取消
            </button>
            <button onClick={submit}>创建</button>
          </div>
        </div>
      )}
    </div>
  );
}

function RoleCard({ r }: { r: RoleInfo }) {
  const store = useHubStore();
  return (
    <div className="card role-card">
      <div className="form-row" style={{ justifyContent: "space-between" }}>
        <span className="title">
          {r.name} {r.builtin ? "(内置)" : ""}
        </span>
        {!r.builtin && (
          <button className="danger" onClick={() => void store.deleteRole(r.id)}>
            删除
          </button>
        )}
      </div>
      <div className="subtitle" style={{ whiteSpace: "pre-wrap" }}>
        {r.persona}
      </div>
      {r.cwd && <div className="subtitle">默认目录: {r.cwd}</div>}
    </div>
  );
}

function FormRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="form-row">
      <label>{label}</label>
      {children}
    </div>
  );
}

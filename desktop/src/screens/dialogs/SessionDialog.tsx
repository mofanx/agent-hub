import { useState } from "react";
import { useHubStore } from "../../hub/store";
import { stringsFor } from "../../hub/strings";
import { FormRow } from "../../components/FormRow";

export function SessionDialog({ onClose }: { onClose: () => void }) {
  const store = useHubStore();
  const S = stringsFor(store.lang);
  const [form, setForm] = useState({
    cwd: "",
    name: "",
    connectionId: "",
    roleId: "",
  });

  const selectedConn = store.connections.find((c) => c.id === form.connectionId);

  const submit = () => {
    if (!form.cwd || !form.name || !form.connectionId) return;
    const conn = store.connections.find((c) => c.id === form.connectionId);
    if (!conn) return;
    void store.createSession(form.cwd, form.name, form.connectionId, form.roleId || undefined);
    onClose();
  };

  const selectRole = (roleId: string) => {
    const role = store.roles.find((r) => r.id === roleId);
    if (!role) {
      setForm({ ...form, roleId: "" });
      return;
    }
    setForm({
      ...form,
      roleId,
      name: role.name,
      cwd: role.cwd || form.cwd,
      connectionId: role.connectionId || form.connectionId,
    });
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{S.newSessionTitle}</h3>
        <FormRow label={S.cwdSection}>
          <input value={form.cwd} onChange={(e) => setForm({ ...form, cwd: e.currentTarget.value })} />
        </FormRow>
        <FormRow label={S.nameLabel}>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} />
        </FormRow>
        <FormRow label={S.connectionLabel}>
          <select value={form.connectionId} onChange={(e) => setForm({ ...form, connectionId: e.currentTarget.value })}>
            <option value="">{S.pleaseSelect}</option>
            {store.connections
              .filter((c) => c.online || c.local)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.agent}) {c.local ? S.localTag : ""}
                </option>
              ))}
          </select>
        </FormRow>
        {selectedConn?.error && <div className="error">{selectedConn.error}</div>}
        <FormRow label={S.roleLabel}>
          <select value={form.roleId} onChange={(e) => selectRole(e.currentTarget.value)}>
            <option value="">{S.optionalLabel}</option>
            {store.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} {r.builtin ? S.builtinTag : ""}
              </option>
            ))}
          </select>
        </FormRow>
        <div className="form-actions">
          <button className="secondary" onClick={onClose}>
            {S.cancelLabel}
          </button>
          <button className="primary" onClick={submit} disabled={!form.cwd || !form.name || !form.connectionId || !selectedConn}>
            {S.createLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

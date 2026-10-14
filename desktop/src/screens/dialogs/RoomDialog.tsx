import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useHubStore } from "../../hub/store";
import { stringsFor, type Strings } from "../../hub/strings";
import type { RoomInfo, RoomModeConfig, SessionInfo } from "../../hub/types";
import { FormRow } from "../../components/FormRow";

type RoomModeOption = { value: string; label: string; description: string };

function roomModeOptions(S: Strings): RoomModeOption[] {
  return [
    { value: "mention", label: S.rmMentionLabel, description: S.rmMentionDesc },
    { value: "conductor", label: S.rmConductorLabel, description: S.rmConductorDesc },
    { value: "roundrobin", label: S.rmRoundrobinLabel, description: S.rmRoundrobinDesc },
    { value: "parallel", label: S.rmParallelLabel, description: S.rmParallelDesc },
    { value: "pipeline", label: S.rmPipelineLabel, description: S.rmPipelineDesc },
    { value: "debate", label: S.rmDebateLabel, description: S.rmDebateDesc },
    { value: "auto", label: S.rmAutoLabel, description: S.rmAutoDesc },
  ];
}

function recommendMode(name: string): string | null {
  const n = name.toLowerCase();
  if (/bug|fix|测试|test|review|审查|重构|refactor|实现|implement|添加功能|feature|任务|分工|拆解/.test(n)) return "conductor";
  if (/brainstorm|头脑风暴|想法|方案|收集|调研|优缺点|分析|集思广益|多观点/.test(n)) return "parallel";
  if (/辩论|debate|正反|利弊|争论|对比|vs|观点碰撞/.test(n)) return "debate";
  if (/流程|流水线|pipeline|步骤|step|顺序|sequence|链路|串联|串行/.test(n)) return "pipeline";
  if (/轮流|轮询|round|依次|每人|顺序发言/.test(n)) return "roundrobin";
  if (/闲聊|讨论|提问|@|广播|通知/.test(n)) return "mention";
  return null;
}

export function RoomDialog({ onClose, editingRoom }: { onClose: () => void; editingRoom?: RoomInfo | null }) {
  const store = useHubStore();
  const S = stringsFor(store.lang);
  const modes = roomModeOptions(S);
  const editing = editingRoom;
  const isEdit = !!editing;
  const [form, setForm] = useState({
    name: editing?.name ?? "",
    mode: editing?.mode ?? "mention",
    selected: (editing?.members.map((m) => m[0]) ?? []) as string[],
    specialId: editing?.conductorId ?? editing?.parallelSummarizerId ?? editing?.debateJudge ?? "",
    pipelineOrder: editing?.pipelineOrder ?? (editing?.members.map((m) => m[0]) ?? []),
    debateSides: (editing?.debateSides ?? ["", ""]) as [string, string],
    debateJudge: editing?.debateJudge ?? "",
    debateRounds: editing?.debateRounds ?? 2,
    memberRoles: (editing?.memberRoles ?? {}) as Record<string, string>,
  });
  const [modeManuallyChanged, setModeManuallyChanged] = useState(false);

  const available = store.sessions.filter((s) => !s.archived);

  const selectedSessions = form.selected
    .map((id) => store.sessions.find((s) => s.sessionId === id))
    .filter((s): s is SessionInfo => !!s);

  const selectedOptions = selectedSessions.map((s) => (
    <option key={s.sessionId} value={s.sessionId}>
      {s.name}
    </option>
  ));

  const ensureDebateDefaults = (selected: string[]) => {
    const sides: [string, string] = [...form.debateSides];
    if (!sides[0] && selected[0]) sides[0] = selected[0];
    if (!sides[1] && selected[1]) sides[1] = selected[1];
    return sides;
  };

  const toggle = (id: string) => {
    const next = form.selected.includes(id)
      ? form.selected.filter((x) => x !== id)
      : [...form.selected, id];
    const nextOrder = form.pipelineOrder.filter((sid) => next.includes(sid));
    for (const sid of next) {
      if (!nextOrder.includes(sid)) nextOrder.push(sid);
    }
    const nextRoles = Object.fromEntries(
      Object.entries(form.memberRoles).filter(([sid]) => next.includes(sid)),
    );
    setForm({
      ...form,
      selected: next,
      specialId: next.includes(form.specialId) ? form.specialId : "",
      pipelineOrder: nextOrder,
      debateSides: ensureDebateDefaults(next),
      debateJudge: next.includes(form.debateJudge) ? form.debateJudge : "",
      memberRoles: nextRoles,
    });
  };

  const movePipeline = (index: number, dir: -1 | 1) => {
    const order = [...form.pipelineOrder];
    const target = index + dir;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    setForm({ ...form, pipelineOrder: order });
  };

  const isValid = (): boolean => {
    if (form.selected.length < (isEdit ? 1 : 2) || !form.name.trim()) return false;
    switch (form.mode) {
      case "conductor":
      case "auto":
      case "roundrobin":
      case "parallel":
      case "debate":
        return !!form.specialId;
      case "pipeline":
        return form.pipelineOrder.length > 0;
      default:
        return true;
    }
  };

  const submit = () => {
    if (!isValid()) return;
    const config: RoomModeConfig = {};
    if (form.specialId) {
      if (form.mode === "conductor" || form.mode === "auto" || form.mode === "roundrobin") {
        config.conductorId = form.specialId;
      } else if (form.mode === "parallel") {
        config.parallelSummarizerId = form.specialId;
      } else if (form.mode === "debate") {
        config.debateJudge = form.specialId;
      }
    }
    if (form.mode === "pipeline" && form.pipelineOrder.length > 0) {
      config.pipelineOrder = form.pipelineOrder;
    }
    if (form.mode === "debate") {
      if (form.debateSides[0] && form.debateSides[1]) {
        config.debateSides = form.debateSides;
      }
      config.debateRounds = Math.max(1, Math.min(5, form.debateRounds));
    }
    const memberRoles = Object.fromEntries(
      Object.entries(form.memberRoles).filter(([, v]) => v.trim()),
    );
    if (isEdit && editing) {
      void store.updateRoom(editing, form.name, form.selected, form.mode, config, memberRoles);
    } else {
      void store.createRoom(form.name, form.selected, form.mode, config, memberRoles);
    }
    onClose();
  };

  const onModeChange = (mode: string) => {
    setModeManuallyChanged(true);
    setForm({
      ...form,
      mode,
      specialId: "",
      debateSides: ensureDebateDefaults(form.selected),
    });
  };

  const renderConfig = () => {
    switch (form.mode) {
      case "conductor":
      case "auto":
      case "roundrobin":
      case "parallel":
      case "debate": {
        const label =
          form.mode === "conductor"
            ? S.conductorLabel
            : form.mode === "auto"
              ? S.moderatorLabel
              : form.mode === "roundrobin"
                ? S.firstSpeakerLabel
                : form.mode === "parallel"
                  ? S.summarizerLabel
                  : S.judgeLabel;
        return (
          <FormRow label={label}>
            <select
              value={form.specialId}
              onChange={(e) => setForm({ ...form, specialId: e.currentTarget.value })}
            >
              <option value="">{S.pleaseSelect}</option>
              {selectedOptions}
            </select>
          </FormRow>
        );
      }
      case "pipeline":
        return (
          <FormRow label={S.pipelineOrderLabel}>
            <div className="pipeline-order">
              {form.pipelineOrder.map((sid, i) => {
                const s = store.sessions.find((x) => x.sessionId === sid);
                if (!s) return null;
                return (
                  <div key={sid} className="pipeline-item">
                    <span className="pipeline-name">
                      {i + 1}. {s.name}
                    </span>
                    <div className="pipeline-actions">
                      <button
                        className="secondary icon-btn"
                        disabled={i === 0}
                        onClick={() => movePipeline(i, -1)}
                      >
                        <ChevronUp size={13} />
                      </button>
                      <button
                        className="secondary icon-btn"
                        disabled={i === form.pipelineOrder.length - 1}
                        onClick={() => movePipeline(i, 1)}
                      >
                        <ChevronDown size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </FormRow>
        );
      default:
        return null;
    }
  };

  const renderDebateConfig = () => {
    if (form.mode !== "debate") return null;
    return (
      <>
        <FormRow label={S.proSideLabel}>
          <select
            value={form.debateSides[0]}
            onChange={(e) =>
              setForm({
                ...form,
                debateSides: [e.currentTarget.value, form.debateSides[1]] as [string, string],
              })
            }
          >
            <option value="">{S.pleaseSelect}</option>
            {selectedOptions}
          </select>
        </FormRow>
        <FormRow label={S.conSideLabel}>
          <select
            value={form.debateSides[1]}
            onChange={(e) =>
              setForm({
                ...form,
                debateSides: [form.debateSides[0], e.currentTarget.value] as [string, string],
              })
            }
          >
            <option value="">{S.pleaseSelect}</option>
            {selectedOptions}
          </select>
        </FormRow>
        <FormRow label={S.roundsLabel}>
          <input
            type="number"
            min={1}
            max={5}
            value={form.debateRounds}
            onChange={(e) =>
              setForm({ ...form, debateRounds: Math.max(1, Math.min(5, Number(e.currentTarget.value) || 1)) })
            }
          />
        </FormRow>
      </>
    );
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{isEdit ? S.editRoomTitle : S.newRoomTitle}</h3>
        <FormRow label={S.nameLabel}>
          <input
            value={form.name}
            onChange={(e) => {
              const name = e.currentTarget.value;
              const next: typeof form = { ...form, name };
              if (!modeManuallyChanged) {
                const recommended = recommendMode(name);
                if (recommended && recommended !== form.mode) {
                  next.mode = recommended;
                  next.specialId = "";
                }
              }
              setForm(next);
            }}
          />
        </FormRow>
        <FormRow label={S.modeSection}>
          <select value={form.mode} onChange={(e) => onModeChange(e.currentTarget.value)}>
            {modes.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </FormRow>
        {(() => {
          const modeInfo = modes.find((m) => m.value === form.mode);
          if (!modeInfo) return null;
          return <div className="mode-description">{modeInfo.description}</div>;
        })()}

        {renderConfig()}
        {renderDebateConfig()}

        <div className="member-picker">
          <h4>{S.pickMembersLabel}</h4>
          {available.map((s) => (
            <div key={s.sessionId} className="member-row">
              <label className="member-check">
                <input
                  type="checkbox"
                  checked={form.selected.includes(s.sessionId)}
                  onChange={() => toggle(s.sessionId)}
                />
                {store.displayName(s)}
              </label>
              {form.selected.includes(s.sessionId) && (
                <select
                  className="role-select"
                  value={form.memberRoles[s.sessionId] ?? ""}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      memberRoles: {
                        ...form.memberRoles,
                        [s.sessionId]: e.currentTarget.value,
                      },
                    })
                  }
                >
                  <option value="">{S.defaultRoleLabel}</option>
                  {store.roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          ))}
        </div>

        <div className="form-actions">
          <button className="secondary" onClick={onClose}>
            {S.cancelLabel}
          </button>
          <button className="primary" onClick={submit} disabled={!isValid()}>
            {isEdit ? S.saveLabel : S.createLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

import type { MissionInfo } from "../hub/types";
import { missionCheckStatusLabel, missionTaskStatusLabel, missionVerdictLabel, stringsFor, type Strings } from "../hub/strings";
import { useHubStore } from "../hub/store";
import type {
  FlowTask,
  FlowVerification,
  VerificationEvidenceDetail,
} from "../hub/types";

function Field({ label, value, S }: { label: string; value: unknown; S: Strings }) {
  if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) {
    return <span className="nav-sub mission-ev-field">{label}: {S.missionNotProvided}</span>;
  }
  const text = Array.isArray(value) ? value.join("\n") : String(value);
  return <span className="nav-sub mission-ev-field">{label}: <pre className="mission-ev-pre">{text}</pre></span>;
}

function PeerDetail({ ed, S }: { ed: VerificationEvidenceDetail; S: Strings }) {
  return (
    <div className="mission-ev-detail">
      <Field label={`${S.missionPeerReview} ${S.missionFieldSummary}`} value={ed.summary} S={S} />
      <Field label={`${S.missionPeerReview} ${S.missionFieldBaseline}`} value={ed.baseline} S={S} />
      <Field label={`${S.missionPeerReview} ${S.missionFieldDiff}`} value={ed.diff} S={S} />
      <Field label={`${S.missionPeerReview} ${S.missionFieldReproSteps}`} value={ed.reproSteps} S={S} />
      <Field label={`${S.missionPeerReview} ${S.missionFieldCommand}`} value={ed.command} S={S} />
      <Field
        label={`${S.missionPeerReview} ${S.missionFieldExitCode}`}
        value={typeof ed.exitCode === "number" ? `${ed.exitCode}${ed.exitCode === 0 ? ` (${S.missionExitZero})` : ""}` : undefined}
        S={S}
      />
      <Field label={`${S.missionPeerReview} ${S.missionFieldStdout}`} value={ed.stdout} S={S} />
      <Field label={`${S.missionPeerReview} ${S.missionFieldStderr}`} value={ed.stderr} S={S} />
      <Field label={`${S.missionPeerReview} ${S.missionFieldArtifacts}`} value={ed.artifactRefs?.join(", ")} S={S} />
    </div>
  );
}

export function MissionEvidence({ mission }: { mission: MissionInfo }) {
  const store = useHubStore();
  const S = stringsFor(store.lang);
  const tasks = Array.isArray(mission.flow?.tasks) ? (mission.flow.tasks as FlowTask[]) : [];
  if (tasks.length === 0 && !mission.output) return null;
  return (
    <details className="mission-evidence">
      <summary className="nav-sub">{S.missionEvidenceDetail}</summary>
      {mission.output && (
        <span className="nav-sub mission-ev-field">
          {S.missionOutput}: <pre className="mission-ev-pre">{mission.output}</pre>
        </span>
      )}
      {tasks.map((t) => {
        const ac = t.automaticCheck as Record<string, unknown> | undefined;
        const vers = Array.isArray(t.verifications) ? (t.verifications as FlowVerification[]) : [];
        return (
          <div key={t.id} className="nav-sub mission-task-evidence">
            <span>
              {t.id} [{missionTaskStatusLabel(S, t.status)}] {t.name}
            </span>
            <Field label={`${S.missionSelfReport} ${S.missionFieldOutput}`} value={t.output} S={S} />
            <Field label={`${S.missionSelfReport} ${S.missionFieldDiff}`} value={t.diff} S={S} />
            <Field label={`${S.missionSelfReport} ${S.missionFieldBaseline}`} value={t.baseline} S={S} />
            <Field label={`${S.missionSelfReport} ${S.missionFieldReproSteps}`} value={t.reproSteps} S={S} />
            <Field
              label={`${S.missionSelfReport} ${S.missionFieldCommand}`}
              value={t.verifyCommand
                ? `${t.verifyCommand}${typeof t.verifyExitCode === "number" ? ` → ${S.missionFieldExitCode} ${t.verifyExitCode}` : ""}${t.verifyExitCode === 0 ? ` (${S.missionExitZero})` : ""}`
                : undefined}
              S={S}
            />
            <Field label={`${S.missionSelfReport} ${S.missionFieldStdout}`} value={t.verifyStdout} S={S} />
            <Field label={`${S.missionSelfReport} ${S.missionFieldStderr}`} value={t.verifyStderr} S={S} />
            {vers.map((v, i) => (
              <span key={i} className="mission-ev-field">
                <span className="nav-sub">
                  {S.missionPeerReview} {v.by}: {S.missionFieldVerdict} {missionVerdictLabel(S, v.verdict)} · {S.missionFieldEvidence} {v.evidence || S.missionNotProvided}
                </span>
                {v.evidenceDetail && <PeerDetail ed={v.evidenceDetail} S={S} />}
              </span>
            ))}
            {ac && String(ac.status ?? "not_run") !== "not_run" && (
              <span className="mission-ev-field">
                <span className="nav-sub">
                  {S.missionIsolatedCheck}: {S.missionFieldStatus} {missionCheckStatusLabel(S, String(ac.status))}
                  {typeof ac.exitCode === "number" ? ` · ${S.missionFieldExitCode} ${ac.exitCode}` : ""}
                  {typeof ac.reason === "string" && ac.reason ? ` · ${ac.reason}` : ""}
                  {ac.snapshotCurrent === false ? ` (${S.missionSnapshotStale})` : ""}
                </span>
                {typeof ac.detail === "string" && ac.detail && (
                  <Field label={S.missionEvidenceDetail} value={ac.detail} S={S} />
                )}
              </span>
            )}
          </div>
        );
      })}
    </details>
  );
}

import { LOST_REASONS, STAGE_LABELS, stageIndex, type DealStage, type DealStatus, type Role } from "@soa/shared";
import { useState } from "react";
import { Btn, Field, inputClass, Modal, Pill } from "./ui";

export function StagePill({ stage, status }: { stage: DealStage; status: DealStatus }) {
  if (status === "lost") return <Pill tone="red">Lost</Pill>;
  return (
    <Pill tone={stage === "won" ? "green" : stageIndex(stage) >= 4 ? "amber" : "blue"}>{STAGE_LABELS[stage]}</Pill>
  );
}

export function FitBadge({ score, reasons }: { score: number | null; reasons: string[] }) {
  const value = score ?? 0;
  const tone =
    value >= 60
      ? "border-emerald-800 bg-emerald-950/40 text-emerald-300"
      : value >= 30
        ? "border-amber-800 bg-amber-950/40 text-amber-300"
        : "border-zinc-700 bg-zinc-900 text-zinc-300";
  return (
    <span
      title={reasons.join(" · ")}
      className={`inline-flex h-8 w-10 items-center justify-center rounded-lg border text-sm font-semibold ${tone}`}
    >
      {score ?? "–"}
    </span>
  );
}

/** Stages a person may choose by hand: up to Proposal for AEs; managers may override to the system stages. */
export const choosableStages = (role: Role): DealStage[] =>
  (Object.keys(STAGE_LABELS) as DealStage[]).filter(
    (stage) => role !== "ae" || stageIndex(stage) <= stageIndex("proposal"),
  );

export function LoseDialog(props: {
  name: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: string, note: string) => void;
}) {
  const [reason, setReason] = useState<string>(LOST_REASONS[0]);
  const [note, setNote] = useState("");
  return (
    <Modal title={`Mark ${props.name} as lost`} onClose={props.onCancel}>
      <div className="space-y-3">
        <Field label="Reason (required)">
          <select
            className={inputClass}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          >
            {LOST_REASONS.map((option) => (
              <option key={option}>{option}</option>
            ))}
          </select>
        </Field>
        <Field label="Note (optional)">
          <input
            className={inputClass}
            value={note}
            maxLength={500}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        </Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Btn onClick={props.onCancel}>Cancel</Btn>
        <Btn
          kind="danger"
          busy={props.busy}
          onClick={() => {
            props.onConfirm(reason, note);
          }}
        >
          Mark lost
        </Btn>
      </div>
    </Modal>
  );
}

/** Stages a manager sets by hand only with a reason (§5). */
export const needsOverrideReason = (stage: DealStage) => stageIndex(stage) > stageIndex("proposal");

export function OverrideDialog(props: {
  stage: DealStage;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <Modal title={`Set ${STAGE_LABELS[props.stage]} by hand`} onClose={props.onCancel}>
      <p className="text-sm text-zinc-400">
        {STAGE_LABELS[props.stage]} is normally set by the e-signature system. Say why you are setting it yourself; this
        is recorded in the audit log.
      </p>
      <div className="mt-3">
        <Field label="Reason (required)">
          <input
            className={inputClass}
            value={reason}
            maxLength={300}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
        </Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Btn onClick={props.onCancel}>Cancel</Btn>
        <Btn
          kind="primary"
          busy={props.busy}
          disabled={reason.trim() === ""}
          onClick={() => {
            props.onConfirm(reason.trim());
          }}
        >
          Set stage
        </Btn>
      </div>
    </Modal>
  );
}

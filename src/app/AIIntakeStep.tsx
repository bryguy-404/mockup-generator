"use client";

import { useMemo, useState, type ChangeEvent } from "react";
import {
  INTAKE_ATTACHMENT_ROLES,
  INTAKE_FIELD_LABELS,
  INTAKE_FORM_REQUIREMENTS,
  INTAKE_LOGO_BACKGROUNDS,
  type ExistingIntakeForm,
  type IntakeAttachment,
  type IntakeAttachmentRole,
  type IntakeDraft,
  type IntakeMessage,
  type MissingRequirement,
  type RemoteAssetCandidate,
  type ResearchContext,
} from "@/lib/intake";

export type IntakeUiState = {
  composer: string;
  messages: IntakeMessage[];
  attachments: IntakeAttachment[];
  draft: IntakeDraft | null;
  warnings: string[];
  missingRequired: MissingRequirement[];
  researchContext: ResearchContext | null;
  attachmentRoles: Record<string, IntakeAttachmentRole>;
  usedModel?: string;
  appliedAt?: number;
};

type Props = {
  state: IntakeUiState;
  onChange: (next: IntakeUiState | ((previous: IntakeUiState) => IntakeUiState)) => void;
  existingForm: ExistingIntakeForm;
  prepareFiles: (files: File[]) => Promise<IntakeAttachment[]>;
  onApply: (state: IntakeUiState) => void;
  onSkip: () => void;
  onImportRemoteAsset: (candidate: RemoteAssetCandidate) => Promise<void>;
};

const MISSING_LABELS: Record<MissingRequirement, string> = {
  clientName: "Client name",
  logo: "Uploaded logo",
  inspirationUrl: "At least one inspiration URL",
};

function messageId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function errorFromPayload(value: unknown, fallback: string) {
  if (value && typeof value === "object" && "error" in value) {
    const error = (value as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
  }
  return fallback;
}

function valueForInput(value: unknown) {
  return Array.isArray(value) ? value.join("\n") : typeof value === "string" ? value : "";
}

export default function AIIntakeStep({
  state,
  onChange,
  existingForm,
  prepareFiles,
  onApply,
  onSkip,
  onImportRemoteAsset,
}: Props) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isPreparingFiles, setIsPreparingFiles] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importingAssetId, setImportingAssetId] = useState<string | null>(null);
  const canSend = Boolean(state.composer.trim()) && !isAnalyzing && state.messages.length < 20;
  const hasConversation = state.messages.length > 0;
  const suggestedFields = useMemo(() => {
    if (!state.draft) return [];
    return (Object.keys(INTAKE_FIELD_LABELS) as Array<keyof typeof INTAKE_FIELD_LABELS>)
      .filter((key) => state.draft?.[key].value !== null);
  }, [state.draft]);

  async function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;
    setError(null);
    setIsPreparingFiles(true);
    try {
      const remaining = 12 - state.attachments.length;
      if (remaining <= 0) throw new Error("AI Brief supports up to 12 images");
      const prepared = await prepareFiles(files.slice(0, remaining));
      onChange((previous) => ({
        ...previous,
        attachments: [...previous.attachments, ...prepared].slice(0, 12),
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not prepare images");
    } finally {
      setIsPreparingFiles(false);
    }
  }

  async function analyze() {
    if (!canSend) return;
    setError(null);
    setIsAnalyzing(true);
    const userMessage: IntakeMessage = {
      id: messageId("user"),
      role: "user",
      text: state.composer.trim(),
      attachmentIds: state.attachments.map((attachment) => attachment.id),
      createdAt: Date.now(),
    };
    const messages = [...state.messages, userMessage].slice(-20);
    onChange((previous) => ({ ...previous, composer: "", messages }));
    const controller = new AbortController();
    try {
      const response = await fetch("/api/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          messages,
          attachments: state.attachments,
          existingForm,
          researchContext: state.researchContext,
        }),
      });
      const data = (await response.json().catch(() => null)) as {
        assistantMessage?: unknown;
        draft?: IntakeDraft;
        warnings?: string[];
        missingRequired?: MissingRequirement[];
        researchContext?: ResearchContext;
        usedModel?: string;
        error?: string;
      } | null;
      if (!response.ok || !data) throw new Error(errorFromPayload(data, "AI Brief analysis failed"));
      if (typeof data.assistantMessage !== "string" || !data.draft) {
        throw new Error("AI Brief returned an incomplete draft");
      }
      const assistantMessage: IntakeMessage = {
        id: messageId("assistant"),
        role: "assistant",
        text: data.assistantMessage,
        createdAt: Date.now(),
      };
      onChange((previous) => ({
        ...previous,
        messages: [...messages, assistantMessage].slice(-20),
        draft: data.draft ?? null,
        warnings: data.warnings ?? [],
        missingRequired: data.missingRequired ?? [],
        researchContext: data.researchContext ?? previous.researchContext,
        usedModel: data.usedModel,
        attachmentRoles: Object.fromEntries(
          (data.draft?.attachmentSuggestions ?? []).map((item) => [
            item.attachmentId,
            previous.attachmentRoles[item.attachmentId] ?? item.role,
          ]),
        ),
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "AI Brief analysis failed");
    } finally {
      setIsAnalyzing(false);
    }
    return () => controller.abort();
  }

  function updateDraftField(field: keyof typeof INTAKE_FIELD_LABELS, raw: string) {
    onChange((previous) => {
      if (!previous.draft) return previous;
      const current = previous.draft[field];
      let value: string | string[] | null = raw.trim() || null;
      if (field === "inspirationUrls") {
        value = raw
          .split(/[\n,]/)
          .map((part) => part.trim())
          .filter(Boolean)
          .slice(0, 3);
        if (!value.length) value = null;
      }
      return {
        ...previous,
        draft: {
          ...previous.draft,
          [field]: { ...current, value },
        } as IntakeDraft,
      };
    });
  }

  function removeAttachment(id: string) {
    onChange((previous) => ({
      ...previous,
      attachments: previous.attachments.filter((attachment) => attachment.id !== id),
      attachmentRoles: Object.fromEntries(
        Object.entries(previous.attachmentRoles).filter(([key]) => key !== id),
      ),
    }));
  }

  function resetBrief() {
    onChange({
      composer: "",
      messages: [],
      attachments: [],
      draft: null,
      warnings: [],
      missingRequired: [],
      researchContext: null,
      attachmentRoles: {},
    });
    setError(null);
  }

  async function importCandidate(candidate: RemoteAssetCandidate) {
    setError(null);
    setImportingAssetId(candidate.id);
    try {
      await onImportRemoteAsset(candidate);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not import website image");
    } finally {
      setImportingAssetId(null);
    }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-3xl border border-indigo-200 bg-gradient-to-br from-indigo-50 via-white to-sky-50 p-5 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <span className="inline-flex rounded-full bg-indigo-100 px-3 py-1 text-xs font-semibold text-indigo-700">
              GPT-5.6 Terra · Firecrawl research
            </span>
            <h3 className="mt-3 text-xl font-semibold tracking-tight text-slate-950">
              Tell me everything in your own words
            </h3>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
              Paste the client website and inspiration links, describe the look, goals, CTA, and anything to avoid. Add logos, photos, or screenshots below. Nothing changes in the form until you review and apply the draft.
            </p>
          </div>
          {hasConversation && (
            <button
              type="button"
              onClick={resetBrief}
              disabled={isAnalyzing}
              className="shrink-0 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:border-slate-300 hover:text-slate-950 disabled:opacity-50"
            >
              Reset AI Brief
            </button>
          )}
        </div>

        {state.messages.length > 0 && (
          <div className="mt-5 max-h-[420px] space-y-3 overflow-y-auto rounded-2xl border border-slate-200/80 bg-white/70 p-3">
            {state.messages.map((message) => (
              <div
                key={message.id}
                className={`max-w-[92%] rounded-2xl px-4 py-3 text-sm leading-6 ${
                  message.role === "user"
                    ? "ml-auto bg-slate-950 text-white"
                    : "border border-slate-200 bg-white text-slate-700"
                }`}
              >
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] opacity-60">
                  {message.role === "user" ? "You" : "AI Brief"}
                </p>
                <p className="whitespace-pre-wrap">{message.text}</p>
              </div>
            ))}
          </div>
        )}

        <textarea
          rows={hasConversation ? 4 : 8}
          value={state.composer}
          maxLength={12_000}
          onChange={(event) =>
            onChange((previous) => ({ ...previous, composer: event.target.value }))
          }
          placeholder="Example: This is for Acme Roofing. Their current site is https://... I like the layout at https://... The audience is homeowners, the main CTA should be Request a Free Estimate, and the direction should feel established, trustworthy, and modern. Avoid generic stock-photo styling."
          className="mt-5 w-full resize-y rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm leading-6 text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100"
        />

        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <label className="inline-flex cursor-pointer items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm hover:border-slate-300">
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              className="sr-only"
              disabled={isPreparingFiles || state.attachments.length >= 12}
              onChange={handleFiles}
            />
            {isPreparingFiles ? "Preparing images…" : "Add images"}
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={onSkip}
              disabled={isAnalyzing}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-600 hover:border-slate-300 hover:text-slate-950 disabled:opacity-50"
            >
              Skip to manual form
            </button>
            <button
              type="button"
              onClick={analyze}
              disabled={!canSend}
              className="rounded-xl bg-slate-950 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-slate-950/15 hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              {isAnalyzing ? "Researching and drafting…" : hasConversation ? "Send follow-up" : "Analyze Brief"}
            </button>
          </div>
        </div>

        {state.attachments.length > 0 && (
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {state.attachments.map((attachment) => (
              <div key={attachment.id} className="group relative overflow-hidden rounded-xl border border-slate-200 bg-white">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={attachment.dataUrl} alt={attachment.name} className="h-24 w-full object-cover" />
                <button
                  type="button"
                  onClick={() => removeAttachment(attachment.id)}
                  className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-slate-950/80 text-white"
                  aria-label={`Remove ${attachment.name}`}
                >
                  ×
                </button>
                <p className="truncate px-2 py-1.5 text-[10px] font-medium text-slate-600">{attachment.name}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {error && <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}

      {state.draft && (
        <div className="space-y-5 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">Review before applying</p>
              <h3 className="mt-1 text-xl font-semibold text-slate-950">AI form draft</h3>
              <p className="mt-1 text-sm text-slate-500">
                {suggestedFields.length} fields suggested{state.usedModel ? ` by ${state.usedModel}` : ""}. Edit anything here before applying it.
              </p>
            </div>
            {state.appliedAt && <span className="text-xs font-medium text-emerald-700">Draft applied · updated suggestions remain reviewable</span>}
          </div>

          {state.missingRequired.length > 0 && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm font-semibold text-amber-900">Still needed before generation</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-800">
                {state.missingRequired.map((item) => <li key={item}>{MISSING_LABELS[item]}</li>)}
              </ul>
            </div>
          )}

          {state.warnings.length > 0 && (
            <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900">
              {state.warnings.map((warning) => <p key={warning}>{warning}</p>)}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {(Object.keys(INTAKE_FIELD_LABELS) as Array<keyof typeof INTAKE_FIELD_LABELS>).map((field) => {
              const suggestion = state.draft![field];
              const isEnum = field === "formRequirement" || field === "logoBackground";
              const options = field === "formRequirement" ? INTAKE_FORM_REQUIREMENTS : INTAKE_LOGO_BACKGROUNDS;
              const existingValue = field === "inspirationUrls"
                ? existingForm.urls
                : existingForm[field as keyof ExistingIntakeForm];
              const hasExistingValue = Array.isArray(existingValue)
                ? existingValue.some(Boolean)
                : typeof existingValue === "string"
                  ? Boolean(existingValue.trim())
                  : existingValue !== undefined && existingValue !== null;
              const wouldReplace =
                hasExistingValue &&
                suggestion.value !== null &&
                JSON.stringify(existingValue) !== JSON.stringify(suggestion.value);
              return (
                <label key={field} className="rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-slate-800">{INTAKE_FIELD_LABELS[field]}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                      suggestion.confidence === "high"
                        ? "bg-emerald-100 text-emerald-700"
                        : suggestion.confidence === "medium"
                          ? "bg-amber-100 text-amber-700"
                          : "bg-slate-200 text-slate-600"
                    }`}>
                      {suggestion.confidence} · {suggestion.source.replace("-", " ")}
                    </span>
                  </span>
                  {wouldReplace && (
                    <span className="mt-2 block text-xs font-semibold text-indigo-700">
                      Diff: applying this suggestion will replace the current form value.
                    </span>
                  )}
                  {isEnum ? (
                    <select
                      value={valueForInput(suggestion.value)}
                      onChange={(event) => updateDraftField(field, event.target.value)}
                      className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
                    >
                      <option value="">Leave unchanged / unknown</option>
                      {options.map((option) => <option key={option} value={option}>{option}</option>)}
                    </select>
                  ) : (
                    <textarea
                      rows={field === "projectBrief" || field === "mustHaves" || field === "styleNotes" ? 3 : 2}
                      value={valueForInput(suggestion.value)}
                      onChange={(event) => updateDraftField(field, event.target.value)}
                      className="mt-2 w-full resize-y rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm leading-5 text-slate-900"
                      placeholder="Unknown — leave blank"
                    />
                  )}
                  <span className="mt-2 block text-xs leading-5 text-slate-500">{suggestion.evidence}</span>
                </label>
              );
            })}
          </div>

          {state.attachments.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-slate-900">Image roles</h4>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {state.attachments.map((attachment) => (
                  <label key={attachment.id} className="flex items-center gap-3 rounded-2xl border border-slate-200 p-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={attachment.dataUrl} alt="" className="h-14 w-14 rounded-xl object-cover" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-semibold text-slate-700">{attachment.name}</span>
                      <select
                        value={state.attachmentRoles[attachment.id] ?? "unknown"}
                        onChange={(event) => onChange((previous) => ({
                          ...previous,
                          attachmentRoles: {
                            ...previous.attachmentRoles,
                            [attachment.id]: event.target.value as IntakeAttachmentRole,
                          },
                        }))}
                        className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700"
                      >
                        {INTAKE_ATTACHMENT_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
                      </select>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {(state.researchContext?.assetCandidates.length ?? 0) > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-slate-900">Website assets found</h4>
              <p className="mt-1 text-xs text-slate-500">These are never imported automatically. Confirm an item to download, validate, and add it to the form.</p>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {state.researchContext!.assetCandidates.map((candidate) => (
                  <div key={candidate.id} className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 p-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-800">{candidate.label}</p>
                      <p className="truncate text-xs text-slate-500">{candidate.url}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => importCandidate(candidate)}
                      disabled={importingAssetId !== null}
                      className="shrink-0 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:border-slate-300 disabled:opacity-50"
                    >
                      {importingAssetId === candidate.id ? "Importing…" : candidate.kind === "logo" ? "Use as logo" : "Add image"}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2 border-t border-slate-200 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs leading-5 text-slate-500">Applying copies reviewed, non-empty values into the manual form. You can still edit every field afterward.</p>
            <button
              type="button"
              onClick={() => onApply(state)}
              className="shrink-0 rounded-xl bg-slate-950 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-slate-800"
            >
              {state.appliedAt ? "Apply Updated Draft" : "Apply Draft to Form"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

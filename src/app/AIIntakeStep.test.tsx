import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AIIntakeStep, { type IntakeUiState } from "@/app/AIIntakeStep";
import { emptyIntakeDraft } from "@/lib/intake";

const initialState: IntakeUiState = {
  composer: "Build a trustworthy roofing site with https://example.com as inspiration.",
  messages: [],
  attachments: [],
  draft: null,
  warnings: [],
  missingRequired: [],
  researchContext: null,
  attachmentRoles: {},
};

function Harness({ onApply }: { onApply: (state: IntakeUiState) => void }) {
  const [state, setState] = useState(initialState);
  return (
    <AIIntakeStep
      state={state}
      onChange={setState}
      existingForm={{}}
      prepareFiles={async () => []}
      onApply={onApply}
      onSkip={() => {}}
      onImportRemoteAsset={async () => {}}
    />
  );
}

describe("AI Brief preview", () => {
  it("does not mutate the form until Apply Draft is clicked", async () => {
    const onApply = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            assistantMessage: "I created a draft. Please add the client name and logo.",
            draft: {
              ...emptyIntakeDraft(),
              inspirationUrls: {
                value: ["https://example.com"],
                confidence: "high",
                source: "user",
                evidence: "The user supplied it as inspiration.",
              },
            },
            missingRequired: ["clientName", "logo"],
            warnings: [],
            researchContext: {
              inspirations: [],
              source: "provider-tools",
              assetCandidates: [],
              colorCandidates: [],
              fetchedAt: Date.now(),
            },
            usedModel: "gpt-5.6-terra",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    render(<Harness onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: "Analyze Brief" }));
    await screen.findByText("AI form draft");
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply Draft to Form" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
  });
});

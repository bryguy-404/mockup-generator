"use client";

import Image from "next/image";
import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";

type Mockup = { name: string; html: string };
type Screenshot = { name: string; dataUrl: string };
type LogoBackground = "light" | "dark" | "either";
type GenerationProvider = "anthropic" | "openai";
type FormRequirement =
  | "none"
  | "contact"
  | "quote"
  | "booking"
  | "newsletter"
  | "custom";
type ShareLink = { id?: string; url: string; expiresAt: number };
type ClientImageRole = "hero" | "services" | "team" | "gallery" | "general";
type ClientImageAsset = {
  id: string;
  name: string;
  role: ClientImageRole;
  dataUrl: string;
  originalBytes: number;
  compressedBytes: number;
};
type CreativeDirection = {
  name: string;
  angle: string;
  palette: string;
  typography: string;
  layout: string;
  imagery: string;
};
type MockupQAReport = {
  name: string;
  pass: boolean;
  score: number;
  issues: string[];
  repairInstructions: string;
};
type GenerationMeta = {
  researchSummary: string;
  directions: CreativeDirection[];
  qaReports: MockupQAReport[];
  usedProvider: GenerationProvider;
  usedModel?: string;
  usedReasoningEffort?: string;
  usedReasoningMode?: string;
  usedServiceTier?: string;
  usedResearchSource: "firecrawl" | "provider-tools" | "mixed";
};
type RefineQAReport = {
  pass: boolean;
  issues: string[];
  checkedViewports: string[];
};

const STORAGE_KEY = "mockup-generator:state";
const MAX_SCREENSHOTS = 3;
const MAX_CLIENT_IMAGES = 12;
const MAX_COMPRESSED_IMAGE_BYTES = 1.5 * 1024 * 1024;
const MAX_GENERATE_REQUEST_BYTES = 24 * 1024 * 1024;
const HOSTED_BODY_LIMIT_HINT_BYTES = 4 * 1024 * 1024;
const IMAGE_QUALITY = 0.82;
const IMAGE_MAX_DIMENSION = 1800;
const INTAKE_STEPS = [
  {
    id: "basics",
    title: "Client Basics",
    description: "Name, website, logo, and brand color hints.",
  },
  {
    id: "direction",
    title: "Project Direction",
    description: "Brief, goals, form needs, audience, and style notes.",
  },
  {
    id: "inspiration",
    title: "Inspiration",
    description: "Comp URLs, notes, and reference screenshots.",
  },
  {
    id: "photos",
    title: "Client Photos",
    description: "Business images, usage roles, and hero direction.",
  },
  {
    id: "generate",
    title: "Generate",
    description: "Choose the model and review before spending credits.",
  },
] as const;
type IntakeStepId = (typeof INTAKE_STEPS)[number]["id"];

const FORM_REQUIREMENT_OPTIONS: Array<{
  id: FormRequirement;
  label: string;
}> = [
  { id: "none", label: "No custom form" },
  { id: "contact", label: "Contact form" },
  { id: "quote", label: "Quote request form" },
  { id: "booking", label: "Booking inquiry form" },
  { id: "newsletter", label: "Newsletter signup" },
  { id: "custom", label: "Custom" },
];

const PROVIDER_OPTIONS = [
  {
    id: "openai",
    title: "OpenAI GPT-5.6 Sol",
    description: "Pro/max reasoning with Fast processing",
  },
  {
    id: "anthropic",
    title: "Anthropic Claude Fable 5",
    description: "Adaptive thinking with max effort",
  },
] as const;

function providerModelLabel(
  provider: GenerationProvider,
  model?: string,
) {
  if (
    !model ||
    (provider === "openai" && model === "gpt-5.6-sol") ||
    (provider === "anthropic" && model === "claude-fable-5")
  ) {
    return PROVIDER_OPTIONS.find((option) => option.id === provider)?.title;
  }
  return `${provider === "openai" ? "OpenAI" : "Anthropic"} ${model}`;
}

function isFormRequirement(value: unknown): value is FormRequirement {
  return (
    value === "none" ||
    value === "contact" ||
    value === "quote" ||
    value === "booking" ||
    value === "newsletter" ||
    value === "custom"
  );
}

type PersistedState = {
  urls: [string, string, string];
  currentSite: string;
  logoDataUrl: string | null;
  logoFileName: string;
  brandColor: string;
  clientName: string;
  screenshots: Screenshot[];
  heroPhotoDataUrl: string | null;
  heroPhotoFileName: string;
  heroDirection: string;
  logoBackground: LogoBackground;
  generationProvider: GenerationProvider;
  projectBrief: string;
  audience: string;
  goals: string;
  mustHaves: string;
  formRequirement: FormRequirement;
  formDetails: string;
  avoidList: string;
  compNotes: string;
  styleNotes: string;
  clientImages: ClientImageAsset[];
  generationMeta: GenerationMeta | null;
  mockups: Mockup[];
  shareLinks: Record<number, ShareLink>;
};

export default function Home() {
  const [urls, setUrls] = useState<[string, string, string]>(["", "", ""]);
  const [currentSite, setCurrentSite] = useState("");
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  const [logoFileName, setLogoFileName] = useState<string>("");
  const [brandColor, setBrandColor] = useState("");
  const [clientName, setClientName] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [mockups, setMockups] = useState<Mockup[]>([]);
  const [exportingIndex, setExportingIndex] = useState<number | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [previewWidth, setPreviewWidth] = useState<
    "mobile" | "tablet" | "desktop"
  >("desktop");
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);
  const [heroPhotoDataUrl, setHeroPhotoDataUrl] = useState<string | null>(null);
  const [heroPhotoFileName, setHeroPhotoFileName] = useState<string>("");
  const [heroDirection, setHeroDirection] = useState("");
  const [logoBackground, setLogoBackground] =
    useState<LogoBackground>("either");
  const [generationProvider, setGenerationProvider] =
    useState<GenerationProvider>("openai");
  const [projectBrief, setProjectBrief] = useState("");
  const [audience, setAudience] = useState("");
  const [goals, setGoals] = useState("");
  const [mustHaves, setMustHaves] = useState("");
  const [formRequirement, setFormRequirement] =
    useState<FormRequirement>("none");
  const [formDetails, setFormDetails] = useState("");
  const [avoidList, setAvoidList] = useState("");
  const [compNotes, setCompNotes] = useState("");
  const [styleNotes, setStyleNotes] = useState("");
  const [clientImages, setClientImages] = useState<ClientImageAsset[]>([]);
  const [clientImageError, setClientImageError] = useState<string | null>(null);
  const [generationMeta, setGenerationMeta] = useState<GenerationMeta | null>(
    null,
  );
  const [generationStage, setGenerationStage] = useState("");
  const [shareLinks, setShareLinks] = useState<Record<number, ShareLink>>({});
  const [sharingIndex, setSharingIndex] = useState<number | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareModalIndex, setShareModalIndex] = useState<number | null>(null);
  const [shareLinkCopied, setShareLinkCopied] = useState(false);
  const [refineInstructions, setRefineInstructions] = useState<
    Record<number, string>
  >({});
  const [refiningIndex, setRefiningIndex] = useState<number | null>(null);
  const [refineErrors, setRefineErrors] = useState<Record<number, string>>({});
  const [refineReports, setRefineReports] = useState<
    Record<number, RefineQAReport>
  >({});
  const [currentStep, setCurrentStep] = useState(0);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as Partial<PersistedState>;
      if (
        Array.isArray(data.urls) &&
        data.urls.length === 3 &&
        data.urls.every((u) => typeof u === "string")
      ) {
        setUrls(data.urls as [string, string, string]);
      }
      if (typeof data.currentSite === "string")
        setCurrentSite(data.currentSite);
      if (typeof data.logoDataUrl === "string")
        setLogoDataUrl(data.logoDataUrl);
      if (typeof data.logoFileName === "string")
        setLogoFileName(data.logoFileName);
      if (typeof data.brandColor === "string") setBrandColor(data.brandColor);
      if (typeof data.clientName === "string") setClientName(data.clientName);
      if (
        Array.isArray(data.mockups) &&
        data.mockups.every(
          (m) =>
            m &&
            typeof (m as Mockup).name === "string" &&
            typeof (m as Mockup).html === "string",
        )
      ) {
        setMockups(data.mockups as Mockup[]);
      }
      if (
        Array.isArray(data.screenshots) &&
        data.screenshots.every(
          (s) =>
            s &&
            typeof (s as Screenshot).name === "string" &&
            typeof (s as Screenshot).dataUrl === "string" &&
            (s as Screenshot).dataUrl.startsWith("data:image/"),
        )
      ) {
        setScreenshots(
          (data.screenshots as Screenshot[]).slice(0, MAX_SCREENSHOTS),
        );
      }
      if (typeof data.heroPhotoDataUrl === "string")
        setHeroPhotoDataUrl(data.heroPhotoDataUrl);
      if (typeof data.heroPhotoFileName === "string")
        setHeroPhotoFileName(data.heroPhotoFileName);
      if (typeof data.heroDirection === "string")
        setHeroDirection(data.heroDirection);
      if (
        data.logoBackground === "light" ||
        data.logoBackground === "dark" ||
        data.logoBackground === "either"
      ) {
        setLogoBackground(data.logoBackground);
      }
      if (
        data.generationProvider === "anthropic" ||
        data.generationProvider === "openai"
      ) {
        setGenerationProvider(data.generationProvider);
      }
      if (typeof data.projectBrief === "string")
        setProjectBrief(data.projectBrief);
      if (typeof data.audience === "string") setAudience(data.audience);
      if (typeof data.goals === "string") setGoals(data.goals);
      if (typeof data.mustHaves === "string") setMustHaves(data.mustHaves);
      if (isFormRequirement(data.formRequirement))
        setFormRequirement(data.formRequirement);
      if (typeof data.formDetails === "string")
        setFormDetails(data.formDetails);
      if (typeof data.avoidList === "string") setAvoidList(data.avoidList);
      if (typeof data.compNotes === "string") setCompNotes(data.compNotes);
      if (typeof data.styleNotes === "string") setStyleNotes(data.styleNotes);
      if (
        Array.isArray(data.clientImages) &&
        data.clientImages.every(
          (img) =>
            img &&
            typeof (img as ClientImageAsset).id === "string" &&
            typeof (img as ClientImageAsset).name === "string" &&
            typeof (img as ClientImageAsset).dataUrl === "string",
        )
      ) {
        setClientImages(
          (data.clientImages as ClientImageAsset[]).slice(
            0,
            MAX_CLIENT_IMAGES,
          ),
        );
      }
      if (data.generationMeta && typeof data.generationMeta === "object") {
        setGenerationMeta(data.generationMeta as GenerationMeta);
      }
      if (data.shareLinks && typeof data.shareLinks === "object") {
        const now = Date.now();
        const cleaned: Record<number, ShareLink> = {};
        for (const [k, v] of Object.entries(
          data.shareLinks as Record<string, ShareLink>,
        )) {
          if (
            v &&
            typeof v.url === "string" &&
            typeof v.expiresAt === "number" &&
            v.expiresAt > now
          ) {
            cleaned[Number(k)] =
              typeof v.id === "string"
                ? { id: v.id, url: v.url, expiresAt: v.expiresAt }
                : { url: v.url, expiresAt: v.expiresAt };
          }
        }
        setShareLinks(cleaned);
      }
    } catch {
      // corrupted state — ignore
    }
  }, []);

  useEffect(() => {
    if (!isLoading) {
      setElapsedSec(0);
      setGenerationStage("");
      return;
    }
    const start = Date.now();
    const id = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      setElapsedSec(elapsed);
      if (elapsed < 20) setGenerationStage("Researching sites and assets");
      else if (elapsed < 55) setGenerationStage("Creating design directions");
      else if (elapsed < 130) setGenerationStage("Generating premium mockups");
      else if (elapsed < 210) setGenerationStage("Reviewing and repairing");
      else setGenerationStage("Final polish");
    }, 1000);
    return () => window.clearInterval(id);
  }, [isLoading]);

  function handleUrlChange(index: 0 | 1 | 2, value: string) {
    setUrls((prev) => {
      const next = [...prev] as [string, string, string];
      next[index] = value;
      return next;
    });
  }

  function dataUrlByteLength(dataUrl: string) {
    const base64 = dataUrl.split(",")[1] ?? "";
    return Math.floor((base64.length * 3) / 4);
  }

  function readFileAsDataUrl(file: File) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result === "string") resolve(result);
        else reject(new Error("Could not read image file"));
      };
      reader.onerror = () => reject(new Error("Could not read image file"));
      reader.readAsDataURL(file);
    });
  }

  function loadImage(dataUrl: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new window.Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Could not decode image"));
      img.src = dataUrl;
    });
  }

  async function compressImageFile(file: File) {
    if (!file.type.startsWith("image/")) {
      throw new Error(`${file.name} is not an image`);
    }
    const originalDataUrl = await readFileAsDataUrl(file);
    if (file.type === "image/gif") {
      if (file.size <= MAX_COMPRESSED_IMAGE_BYTES) {
        return { dataUrl: originalDataUrl, bytes: file.size };
      }
      throw new Error(`${file.name} is an animated/large GIF. Use JPG, PNG, or WEBP.`);
    }

    const img = await loadImage(originalDataUrl);
    const scale = Math.min(
      1,
      IMAGE_MAX_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight),
    );
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not prepare image compressor");
    ctx.drawImage(img, 0, 0, width, height);

    let quality = IMAGE_QUALITY;
    let dataUrl = canvas.toDataURL("image/jpeg", quality);
    while (dataUrlByteLength(dataUrl) > MAX_COMPRESSED_IMAGE_BYTES && quality > 0.55) {
      quality -= 0.08;
      dataUrl = canvas.toDataURL("image/jpeg", quality);
    }
    const bytes = dataUrlByteLength(dataUrl);
    if (bytes > MAX_COMPRESSED_IMAGE_BYTES) {
      throw new Error(`${file.name} is still over 1.5MB after compression`);
    }
    return { dataUrl, bytes };
  }

  async function compressLogoFile(file: File) {
    if (!file.type.startsWith("image/")) {
      throw new Error(`${file.name} is not an image`);
    }
    const originalDataUrl = await readFileAsDataUrl(file);
    if (file.size <= MAX_COMPRESSED_IMAGE_BYTES) {
      return { dataUrl: originalDataUrl, bytes: file.size };
    }
    if (file.type === "image/gif") {
      throw new Error(`${file.name} is an animated/large GIF. Use PNG or WEBP for the logo.`);
    }

    const img = await loadImage(originalDataUrl);
    const scale = Math.min(
      1,
      IMAGE_MAX_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight),
    );
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not prepare logo compressor");
    ctx.drawImage(img, 0, 0, width, height);

    let quality = IMAGE_QUALITY;
    let dataUrl = canvas.toDataURL("image/webp", quality);
    while (dataUrlByteLength(dataUrl) > MAX_COMPRESSED_IMAGE_BYTES && quality > 0.55) {
      quality -= 0.08;
      dataUrl = canvas.toDataURL("image/webp", quality);
    }
    const bytes = dataUrlByteLength(dataUrl);
    if (bytes > MAX_COMPRESSED_IMAGE_BYTES) {
      throw new Error(`${file.name} is still over 1.5MB after compression`);
    }
    return { dataUrl, bytes };
  }

  function formatBytes(bytes: number) {
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  function getPayloadErrorHint(requestBytes?: number) {
    if (requestBytes && requestBytes > HOSTED_BODY_LIMIT_HINT_BYTES) {
      return ` The request was ${formatBytes(requestBytes)}, so this may be a hosting request-size limit. Try fewer client images/screenshots or smaller uploads.`;
    }
    return " Check the server logs for the API route failure.";
  }

  function errorFromPayload(data: unknown, fallback: string) {
    if (data && typeof data === "object" && "error" in data) {
      const error = (data as { error?: unknown }).error;
      if (typeof error === "string" && error.trim()) return error;
    }
    return fallback;
  }

  async function readJsonResponse<T>(
    res: Response,
    fallback: string,
    requestBytes?: number,
  ): Promise<T> {
    const contentType = res.headers.get("content-type") ?? "";
    const text = await res.text();
    const trimmed = text.trim();

    if (contentType.includes("application/json") || trimmed.startsWith("{")) {
      try {
        return JSON.parse(trimmed) as T;
      } catch {
        throw new Error(`${fallback}: server returned malformed JSON.`);
      }
    }

    const status = res.status ? `HTTP ${res.status}` : "a non-JSON response";
    const kind = contentType ? `${contentType} response` : "non-JSON response";
    if (!res.ok) {
      throw new Error(
        `${fallback}: server returned ${status} (${kind}) instead of JSON.${getPayloadErrorHint(
          requestBytes,
        )}`,
      );
    }
    throw new Error(
      `${fallback}: server returned ${kind} instead of JSON.${getPayloadErrorHint(
        requestBytes,
      )}`,
    );
  }

  async function handleLogoChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) {
      setLogoDataUrl(null);
      setLogoFileName("");
      return;
    }
    setError(null);
    try {
      const compressed = await compressLogoFile(file);
      setLogoFileName(
        `${file.name} (${formatBytes(file.size)} → ${formatBytes(compressed.bytes)})`,
      );
      setLogoDataUrl(compressed.dataUrl);
    } catch (err) {
      setLogoDataUrl(null);
      setLogoFileName("");
      setError(err instanceof Error ? err.message : "Could not prepare logo image");
      e.target.value = "";
    }
  }

  async function handleHeroPhotoChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) {
      setHeroPhotoDataUrl(null);
      setHeroPhotoFileName("");
      return;
    }
    setError(null);
    try {
      const compressed = await compressImageFile(file);
      setHeroPhotoFileName(
        `${file.name} (${formatBytes(file.size)} → ${formatBytes(compressed.bytes)})`,
      );
      setHeroPhotoDataUrl(compressed.dataUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not compress hero photo");
      e.target.value = "";
    }
  }

  async function handleScreenshotChange(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;

    setScreenshotError(null);
    const remaining = MAX_SCREENSHOTS - screenshots.length;
    if (remaining <= 0) {
      setScreenshotError(`Maximum ${MAX_SCREENSHOTS} screenshots`);
      return;
    }

    const rejected: string[] = [];
    const accepted = files.slice(0, remaining);
    if (files.length > remaining) {
      rejected.push(
        `Only ${remaining} more accepted (max ${MAX_SCREENSHOTS} total)`,
      );
    }

    const results: Screenshot[] = [];
    for (const file of accepted) {
      try {
        const compressed = await compressImageFile(file);
        results.push({
          name: `${file.name} (${formatBytes(file.size)} → ${formatBytes(compressed.bytes)})`,
          dataUrl: compressed.dataUrl,
        });
      } catch (err) {
        rejected.push(err instanceof Error ? err.message : `${file.name} failed`);
      }
    }
    if (rejected.length > 0) setScreenshotError(rejected.join("; "));
    if (results.length > 0) {
      setScreenshots((prev) => [...prev, ...results].slice(0, MAX_SCREENSHOTS));
    }
  }

  function removeScreenshot(index: number) {
    setScreenshots((prev) => prev.filter((_, i) => i !== index));
    setScreenshotError(null);
  }

  async function handleClientImagesChange(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;

    setClientImageError(null);
    const remaining = MAX_CLIENT_IMAGES - clientImages.length;
    if (remaining <= 0) {
      setClientImageError(`Maximum ${MAX_CLIENT_IMAGES} client images`);
      return;
    }

    const rejected: string[] = [];
    const next: ClientImageAsset[] = [];
    const selected = files.slice(0, remaining);
    const hasHero = clientImages.some((img) => img.role === "hero");

    for (let index = 0; index < selected.length; index++) {
      const file = selected[index];
      try {
        const compressed = await compressImageFile(file);
        const role: ClientImageRole =
          !hasHero && clientImages.length === 0 && index === 0
            ? "hero"
            : "general";
        next.push({
          id: `${Date.now().toString(36)}_${index}_${Math.random()
            .toString(36)
            .slice(2, 8)}`,
          name: file.name,
          role,
          dataUrl: compressed.dataUrl,
          originalBytes: file.size,
          compressedBytes: compressed.bytes,
        });
      } catch (err) {
        rejected.push(err instanceof Error ? err.message : `${file.name} failed`);
      }
    }
    if (files.length > remaining) {
      rejected.push(`Only ${remaining} more accepted (max ${MAX_CLIENT_IMAGES} total)`);
    }
    if (rejected.length > 0) setClientImageError(rejected.join("; "));
    if (next.length > 0) {
      setClientImages((prev) => [...prev, ...next].slice(0, MAX_CLIENT_IMAGES));
    }
  }

  function updateClientImageRole(id: string, role: ClientImageRole) {
    setClientImages((prev) =>
      prev.map((img) => (img.id === id ? { ...img, role } : img)),
    );
  }

  function removeClientImage(id: string) {
    setClientImages((prev) => prev.filter((img) => img.id !== id));
    setClientImageError(null);
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (!isLastStep) {
      goNext();
      return;
    }

    if (!logoDataUrl) {
      setError("Please upload a logo image");
      setCurrentStep(0);
      return;
    }

    if (!clientName.trim()) {
      setError("Please enter a client name");
      setCurrentStep(0);
      return;
    }

    if (!firstInspirationUrl) {
      setError("Please add at least one inspiration URL");
      setCurrentStep(2);
      return;
    }

    setIsLoading(true);
    setGenerationStage("Researching sites and assets");
    setMockups([]);
    setGenerationMeta(null);
    setRefineInstructions({});
    setRefineErrors({});
    setRefineReports({});
    setShareLinks({});
    setShareModalIndex(null);
    setShareError(null);

    try {
      const payload = {
        urls,
        currentSite,
        logoDataUrl,
        brandColor,
        clientName,
        screenshots: screenshots.map((s) => s.dataUrl),
        heroPhotoDataUrl,
        heroDirection,
        logoBackground,
        generationProvider,
        projectBrief,
        clientImages,
        audience,
        goals,
        mustHaves,
        formRequirement,
        formDetails,
        avoidList,
        compNotes,
        styleNotes,
        qualityMode: "premium",
      };
      const requestJson = JSON.stringify(payload);
      const requestBytes = new Blob([requestJson]).size;
      if (requestBytes > MAX_GENERATE_REQUEST_BYTES) {
        throw new Error(
          `Uploads are too large for one generation request (${formatBytes(
            requestBytes,
          )}). Remove a few client images/screenshots or upload smaller files.`,
        );
      }

      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestJson,
      });

      const data = await readJsonResponse<Record<string, unknown>>(
        res,
        "Generation failed",
        requestBytes,
      );
      if (!res.ok) {
        throw new Error(errorFromPayload(data, "Generation failed"));
      }
      const fresh = data.mockups as Mockup[];
      setMockups(fresh);
      const meta: GenerationMeta = {
        researchSummary: (data.researchSummary as string) ?? "",
        directions: (data.directions as CreativeDirection[]) ?? [],
        qaReports: (data.qaReports as MockupQAReport[]) ?? [],
        usedProvider: (data.usedProvider as GenerationProvider) ?? generationProvider,
        usedModel:
          typeof data.usedModel === "string" ? data.usedModel : undefined,
        usedReasoningEffort:
          typeof data.usedReasoningEffort === "string"
            ? data.usedReasoningEffort
            : undefined,
        usedReasoningMode:
          typeof data.usedReasoningMode === "string"
            ? data.usedReasoningMode
            : undefined,
        usedServiceTier:
          typeof data.usedServiceTier === "string"
            ? data.usedServiceTier
            : undefined,
        usedResearchSource:
          (data.usedResearchSource as GenerationMeta["usedResearchSource"]) ??
          "provider-tools",
      };
      setGenerationMeta(meta);
      try {
        const persisted: PersistedState = {
          urls,
          currentSite,
          logoDataUrl,
          logoFileName,
          brandColor,
          clientName,
          screenshots,
          heroPhotoDataUrl,
          heroPhotoFileName,
          heroDirection,
          logoBackground,
          generationProvider,
          projectBrief,
          audience,
          goals,
          mustHaves,
          formRequirement,
          formDetails,
          avoidList,
          compNotes,
          styleNotes,
          clientImages,
          generationMeta: meta,
          mockups: fresh,
          shareLinks: {},
        };
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
      } catch (storageErr) {
        console.warn("Could not persist state to sessionStorage", storageErr);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleUseThisDesign(mockup: Mockup, index: number) {
    setExportingIndex(index);
    setExportError(null);

    try {
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html: mockup.html, clientName }),
      });

      const data = await readJsonResponse<Record<string, unknown>>(
        res,
        "Export failed",
      );
      if (!res.ok) {
        throw new Error(errorFromPayload(data, "Export failed"));
      }

      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      zip.file("CLAUDE_KICKOFF.md", data.kickoff as string);
      zip.file("BUILD_PROMPT.md", data.buildPrompt as string);
      zip.file("BLUEPRINT.md", data.blueprint as string);
      zip.file("theme.config.ts", data.themeConfig as string);
      zip.file("RUN_LOOP.md", data.runLoop as string);
      zip.file("visual-diff.mjs", data.visualDiff as string);
      zip.folder("design")?.file("index.html", mockup.html);

      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${data.slug}-design.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExportingIndex(null);
    }
  }

  function downloadMockup(mockup: Mockup) {
    const safeClient =
      clientName.trim().replace(/[^a-z0-9-_]+/gi, "-") || "client";
    const safeName = mockup.name.replace(/[^a-z0-9-_]+/gi, "-");
    const blob = new Blob([mockup.html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safeClient}-${safeName}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function handleCreateShareLink(index: number, mockup: Mockup) {
    setShareError(null);
    setShareLinkCopied(false);

    const cached = shareLinks[index];
    if (cached && cached.expiresAt > Date.now()) {
      setShareModalIndex(index);
      return;
    }

    setSharingIndex(index);
    try {
      const res = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html: mockup.html }),
      });
      const data = await readJsonResponse<Record<string, unknown>>(
        res,
        "Could not create share link",
      );
      if (!res.ok) {
        throw new Error(errorFromPayload(data, "Could not create share link"));
      }
      const next: Record<number, ShareLink> = {
        ...shareLinks,
        [index]: {
          id: data.id as string,
          url: data.url as string,
          expiresAt: data.expiresAt as number,
        },
      };
      setShareLinks(next);
      setShareModalIndex(index);
      try {
        const raw = sessionStorage.getItem(STORAGE_KEY);
        const existing = raw ? JSON.parse(raw) : {};
        sessionStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ ...existing, shareLinks: next }),
        );
      } catch {
        // best effort
      }
    } catch (err) {
      setShareError(
        err instanceof Error ? err.message : "Could not create share link",
      );
    } finally {
      setSharingIndex(null);
    }
  }

  async function handleRefineMockup(index: number, mockup: Mockup) {
    const instruction = (refineInstructions[index] ?? "").trim();
    if (!instruction) {
      setRefineErrors((prev) => ({
        ...prev,
        [index]: "Describe the tweak you want for this design.",
      }));
      return;
    }

    setRefiningIndex(index);
    setShareError(null);
    setRefineErrors((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });

    try {
      const res = await fetch("/api/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          html: mockup.html,
          instruction,
          clientName,
          mockupName: mockup.name,
          generationProvider,
          projectBrief,
          styleNotes,
        }),
      });
      const data = await readJsonResponse<Record<string, unknown>>(
        res,
        "Refinement failed",
      );
      if (!res.ok) {
        throw new Error(errorFromPayload(data, "Refinement failed"));
      }

      const refined = data.mockup as Mockup;
      const qaReport = data.qaReport as RefineQAReport | undefined;
      const nextMockups = mockups.map((m, i) => (i === index ? refined : m));
      let nextShareLinks = shareLinks;
      const activeShareLink = shareLinks[index];

      if (activeShareLink?.id) {
        try {
          const shareRes = await fetch("/api/share", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: activeShareLink.id,
              html: refined.html,
            }),
          });
          const shareData = await readJsonResponse<Record<string, unknown>>(
            shareRes,
            "Could not refresh share link",
          );
          if (!shareRes.ok) {
            throw new Error(errorFromPayload(shareData, "Could not refresh share link"));
          }

          nextShareLinks = {
            ...shareLinks,
            [index]: {
              id: shareData.id as string,
              url: shareData.url as string,
              expiresAt: shareData.expiresAt as number,
            },
          };
          setShareLinks(nextShareLinks);
        } catch (shareErr) {
          nextShareLinks = { ...shareLinks };
          delete nextShareLinks[index];
          setShareLinks(nextShareLinks);
          if (shareModalIndex === index) {
            setShareModalIndex(null);
          }
          setShareError(
            shareErr instanceof Error
              ? `${shareErr.message}. Create a new share link before sending it.`
              : "Could not refresh share link. Create a new share link before sending it.",
          );
        }
      } else if (activeShareLink) {
        nextShareLinks = { ...shareLinks };
        delete nextShareLinks[index];
        setShareLinks(nextShareLinks);
        if (shareModalIndex === index) {
          setShareModalIndex(null);
        }
      }

      setMockups(nextMockups);
      setRefineInstructions((prev) => ({ ...prev, [index]: "" }));
      if (qaReport) {
        setRefineReports((prev) => ({ ...prev, [index]: qaReport }));
      }
      try {
        const raw = sessionStorage.getItem(STORAGE_KEY);
        const existing = raw ? JSON.parse(raw) : {};
        sessionStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            ...existing,
            mockups: nextMockups,
            shareLinks: nextShareLinks,
          }),
        );
      } catch {
        // best effort
      }
    } catch (err) {
      setRefineErrors((prev) => ({
        ...prev,
        [index]: err instanceof Error ? err.message : "Refinement failed",
      }));
    } finally {
      setRefiningIndex(null);
    }
  }

  async function copyShareLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setShareLinkCopied(true);
      window.setTimeout(() => setShareLinkCopied(false), 2000);
    } catch {
      setShareError("Could not copy. Select the link and copy manually.");
    }
  }

  function closeShareModal() {
    setShareModalIndex(null);
    setShareLinkCopied(false);
  }

  function formatExpiry(ms: number) {
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  const activeStep = INTAKE_STEPS[currentStep];
  const activeStepId: IntakeStepId = activeStep.id;
  const isLastStep = currentStep === INTAKE_STEPS.length - 1;
  const selectedFormOption =
    FORM_REQUIREMENT_OPTIONS.find((opt) => opt.id === formRequirement) ??
    FORM_REQUIREMENT_OPTIONS[0];
  const firstInspirationUrl = urls[0].trim();
  const canLeaveBasics = Boolean(clientName.trim() && logoDataUrl);
  const canLeaveInspiration = Boolean(firstInspirationUrl);
  const stepReady =
    activeStepId === "basics"
      ? canLeaveBasics
      : activeStepId === "inspiration"
        ? canLeaveInspiration
        : true;
  const stepStatus = (index: number) => {
    if (index < currentStep) return "Complete";
    if (index === currentStep) return "Current";
    return "Upcoming";
  };
  const canVisitStep = (index: number) => index <= currentStep;
  const nextBlockedMessage =
    activeStepId === "basics"
      ? "Add a client name and logo before continuing."
      : activeStepId === "inspiration"
        ? "Add at least one inspiration URL before continuing."
        : "";

  function goToStep(index: number) {
    if (!canVisitStep(index)) return;
    setCurrentStep(Math.max(0, Math.min(INTAKE_STEPS.length - 1, index)));
  }

  function goNext() {
    if (!stepReady) return;
    setCurrentStep((prev) => Math.min(INTAKE_STEPS.length - 1, prev + 1));
  }

  return (
    <div className="min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top_left,_#dbeafe,_transparent_32%),linear-gradient(135deg,_#f8fafc_0%,_#eef2ff_48%,_#f8fafc_100%)] text-slate-950">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
        <Image
          src="/ADAPrimary.PNG"
          alt="Alphadog Agency"
          width={1800}
          height={720}
          priority
          className="mx-auto mb-6 block h-12 w-auto sm:h-16 lg:h-24"
        />
        <header className="mb-8 max-w-3xl">
          <div className="mb-4 inline-flex items-center rounded-full border border-white/70 bg-white/70 px-3 py-1 text-xs font-medium text-slate-600 shadow-sm backdrop-blur">
            AI-powered homepage concepts
          </div>
          <h1 className="text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
            Mockup Generator
          </h1>
          <p className="mt-3 text-base leading-7 text-slate-600 sm:text-lg">
            Generate three distinct homepage mockups from inspiration sites,
            brand direction, and a logo, then review each concept at a more
            realistic width.
          </p>
        </header>

        <form
          id="generate-form"
          onSubmit={handleSubmit}
          className="rounded-3xl border border-white/70 bg-white/85 p-5 shadow-xl shadow-slate-200/70 backdrop-blur sm:p-8"
        >
          <div className="mb-6 flex flex-col gap-2 border-b border-slate-200/80 pb-6 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold tracking-tight text-slate-950">
                {activeStep.title}
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                Step {currentStep + 1} of {INTAKE_STEPS.length} ·{" "}
                {activeStep.description}
              </p>
            </div>
            <span className="rounded-full bg-slate-950 px-3 py-1 text-xs font-medium text-white">
              3 concepts per run
            </span>
          </div>

          <div className="mb-6 grid grid-cols-1 gap-2 md:grid-cols-5">
            {INTAKE_STEPS.map((step, index) => {
              const selected = index === currentStep;
              const locked = !canVisitStep(index);
              return (
                <button
                  key={step.id}
                  type="button"
                  disabled={locked}
                  aria-disabled={locked}
                  onClick={() => goToStep(index)}
                  className={`rounded-2xl border px-3 py-3 text-left transition ${
                    selected
                      ? "border-slate-950 bg-slate-950 text-white shadow-lg shadow-slate-950/15"
                      : locked
                        ? "cursor-not-allowed border-slate-200 bg-slate-100/70 text-slate-300 opacity-70"
                        : "border-slate-200 bg-white/75 text-slate-700 hover:border-slate-300 hover:bg-white"
                  }`}
                >
                  <span
                    className={`block text-[10px] font-medium uppercase tracking-[0.16em] ${
                      selected
                        ? "text-slate-300"
                        : locked
                          ? "text-slate-300"
                          : "text-slate-400"
                    }`}
                  >
                    {stepStatus(index)}
                  </span>
                  <span className="mt-1 block text-sm font-semibold">
                    {index + 1}. {step.title}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="space-y-6">
            <fieldset
              className={`rounded-2xl border border-slate-200/70 bg-white/60 p-4 sm:p-5 ${
                activeStepId === "generate" ? "" : "hidden"
              }`}
            >
              <legend className="text-sm font-semibold tracking-tight text-slate-900">
                Generation engine
              </legend>
              <p className="mt-1 text-xs text-slate-500">
                Premium mode uses staged research, design directions, visual
                QA, and one repair pass. Firecrawl is used first when
                configured.
              </p>
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {PROVIDER_OPTIONS.map((opt) => (
                  <label
                    key={opt.id}
                    className={`cursor-pointer rounded-2xl border p-4 transition ${
                      generationProvider === opt.id
                        ? "border-slate-950 bg-slate-950 text-white shadow-lg shadow-slate-950/15"
                        : "border-slate-200 bg-white text-slate-900 hover:border-slate-300"
                    }`}
                  >
                    <span className="flex items-start gap-3">
                      <input
                        type="radio"
                        name="generationProvider"
                        value={opt.id}
                        checked={generationProvider === opt.id}
                        onChange={() => setGenerationProvider(opt.id)}
                        className="mt-1"
                      />
                      <span>
                        <span className="block text-sm font-semibold">
                          {opt.title}
                        </span>
                        <span
                          className={`mt-1 block text-xs leading-5 ${
                            generationProvider === opt.id
                              ? "text-slate-200"
                              : "text-slate-500"
                          }`}
                        >
                          {opt.description}
                        </span>
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className={activeStepId === "basics" ? "" : "hidden"}>
              <label className="block text-sm font-semibold text-slate-800 mb-2">
                Client&rsquo;s current website (optional)
              </label>
              <input
                type="url"
                placeholder="https://acmecoffee.com — leave blank if they don't have one"
                value={currentSite}
                onChange={(e) => setCurrentSite(e.target.value)}
                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-slate-400 focus:ring-4 focus:ring-slate-900/10"
              />
              <p className="mt-1 text-xs text-slate-500">
                If provided, the selected engine will inspect this site first to
                use the client&rsquo;s real copy, voice, and palette as canonical
                brand truth.
              </p>
            </div>

            <div className={activeStepId === "direction" ? "" : "hidden"}>
              <label className="block text-sm font-semibold text-slate-800 mb-2">
                Project brief (optional)
              </label>
              <textarea
                rows={3}
                placeholder="E-commerce site — needs product cards with prices and Buy Now buttons, plus a shop section. Or: booking-driven (calendar/appointment CTA). Or: portfolio (gallery grid)."
                value={projectBrief}
                onChange={(e) => setProjectBrief(e.target.value)}
                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-slate-400 focus:ring-4 focus:ring-slate-900/10"
              />
              <p className="mt-1 text-xs text-slate-500">
                What kind of site is this and what functional features must it
                include? Use this when the site needs more than the standard
                services-page template — e-commerce, booking, gallery, menu,
                etc. Applies to all three concepts and works the same for both
                engines.
              </p>
            </div>

            <div
              className={`grid grid-cols-1 gap-4 md:grid-cols-2 ${
                activeStepId === "direction" ? "" : "hidden"
              }`}
            >
              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-800">
                  Form needed
                </label>
                <select
                  value={formRequirement}
                  onChange={(e) =>
                    setFormRequirement(e.target.value as FormRequirement)
                  }
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition focus:border-slate-400 focus:ring-4 focus:ring-slate-900/10"
                >
                  {FORM_REQUIREMENT_OPTIONS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-slate-500">
                  Choose a form only when the final site should collect or send
                  submissions.
                </p>
              </div>

              {formRequirement !== "none" && (
                <div>
                  <label className="mb-2 block text-sm font-semibold text-slate-800">
                    Form details
                  </label>
                  <textarea
                    rows={3}
                    placeholder="Name, email, phone, service interested in, preferred date, message..."
                    value={formDetails}
                    onChange={(e) => setFormDetails(e.target.value)}
                    className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-slate-400 focus:ring-4 focus:ring-slate-900/10"
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    Used to make the mockup include the right fields. Resend
                    setup is added later only if the design includes a real
                    form.
                  </p>
                </div>
              )}
            </div>

            <div
              className={`grid grid-cols-1 gap-4 md:grid-cols-2 ${
                activeStepId === "direction" ? "" : "hidden"
              }`}
            >
              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-800">
                  Audience (optional)
                </label>
                <input
                  type="text"
                  placeholder="Busy homeowners, brides, patients, local business owners..."
                  value={audience}
                  onChange={(e) => setAudience(e.target.value)}
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-slate-400 focus:ring-4 focus:ring-slate-900/10"
                />
              </div>
              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-800">
                  Goals (optional)
                </label>
                <input
                  type="text"
                  placeholder="Book calls, sell products, show premium work, collect leads..."
                  value={goals}
                  onChange={(e) => setGoals(e.target.value)}
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-slate-400 focus:ring-4 focus:ring-slate-900/10"
                />
              </div>
              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-800">
                  Must include (optional)
                </label>
                <textarea
                  rows={3}
                  placeholder="Financing, booking calendar, team photos, service areas, reviews, map..."
                  value={mustHaves}
                  onChange={(e) => setMustHaves(e.target.value)}
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-slate-400 focus:ring-4 focus:ring-slate-900/10"
                />
              </div>
              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-800">
                  Avoid (optional)
                </label>
                <textarea
                  rows={3}
                  placeholder="No stock-photo feel, avoid orange, do not copy competitor wording..."
                  value={avoidList}
                  onChange={(e) => setAvoidList(e.target.value)}
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-slate-400 focus:ring-4 focus:ring-slate-900/10"
                />
              </div>
              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-800">
                  Comp URL notes (optional)
                </label>
                <textarea
                  rows={3}
                  placeholder="Use URL 1 for layout, URL 2 for colors, URL 3 for hero vibe only."
                  value={compNotes}
                  onChange={(e) => setCompNotes(e.target.value)}
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-slate-400 focus:ring-4 focus:ring-slate-900/10"
                />
              </div>
              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-800">
                  Style notes (optional)
                </label>
                <textarea
                  rows={3}
                  placeholder="Luxury but friendly, high-end editorial, bold local service brand..."
                  value={styleNotes}
                  onChange={(e) => setStyleNotes(e.target.value)}
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-slate-400 focus:ring-4 focus:ring-slate-900/10"
                />
              </div>
            </div>

            <div
              className={`grid grid-cols-1 gap-4 md:grid-cols-3 ${
                activeStepId === "inspiration" ? "" : "hidden"
              }`}
            >
              {[0, 1, 2].map((i) => (
                <div key={i}>
                  <label className="mb-2 block text-sm font-semibold text-slate-800">
                    Inspiration URL {i + 1}
                    {i > 0 && (
                      <span className="text-slate-400 font-normal">
                        {" "}
                        (optional)
                      </span>
                    )}
                  </label>
                  <input
                    type="url"
                    required={i === 0}
                    placeholder="https://example.com"
                    value={urls[i]}
                    onChange={(e) =>
                      handleUrlChange(i as 0 | 1 | 2, e.target.value)
                    }
                    className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-slate-400 focus:ring-4 focus:ring-slate-900/10"
                  />
                </div>
              ))}
            </div>
            <p
              className={`-mt-3 text-xs text-slate-500 ${
                activeStepId === "inspiration" ? "" : "hidden"
              }`}
            >
              At least one inspiration URL required; up to three.
            </p>

            <div
              className={`rounded-2xl border border-slate-200/70 bg-white/60 p-4 sm:p-5 ${
                activeStepId === "photos" ? "" : "hidden"
              }`}
            >
              <div className="mb-4">
                <h3 className="text-sm font-semibold tracking-tight text-slate-900">
                  Client business photos (optional)
                </h3>
                <p className="mt-1 text-xs text-slate-500">
                  Add real client images for hero, service, team, and gallery
                  sections. Large uploads are compressed in your browser before
                  they are sent to the generator.
                </p>
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-2 block text-sm font-semibold text-slate-800">
                    Client photo library
                  </label>
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    disabled={clientImages.length >= MAX_CLIENT_IMAGES}
                    onChange={handleClientImagesChange}
                    className="block w-full cursor-pointer rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-3 text-sm text-slate-700 shadow-sm transition file:mr-3 file:rounded-xl file:border-0 file:bg-slate-950 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:border-slate-400 hover:file:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    Up to {MAX_CLIENT_IMAGES} images. First upload defaults to
                    hero; adjust roles below.
                  </p>
                  {clientImageError && (
                    <p className="mt-1 text-xs text-red-600">
                      {clientImageError}
                    </p>
                  )}
                  <div className="mt-3">
                    <label className="mb-2 block text-xs font-medium text-slate-600">
                      Legacy single hero photo
                    </label>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleHeroPhotoChange}
                      className="block w-full cursor-pointer rounded-xl border border-dashed border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 file:mr-2 file:rounded-lg file:border-0 file:bg-slate-100 file:px-2 file:py-1 file:text-xs file:font-medium hover:border-slate-300"
                    />
                    {heroPhotoFileName && (
                      <p className="mt-1 truncate text-xs text-slate-500">
                        {heroPhotoFileName}
                      </p>
                    )}
                  </div>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-semibold text-slate-800">
                    Hero direction
                  </label>
                  <textarea
                    rows={3}
                    placeholder="Split layout with photo on right, big serif headline, soft gradient overlay over image"
                    value={heroDirection}
                    onChange={(e) => setHeroDirection(e.target.value)}
                    className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-slate-400 focus:ring-4 focus:ring-slate-900/10"
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    Compositional notes only — the AI designs the rest. Same
                    direction applies to all three concepts.
                  </p>
                </div>
              </div>
              {clientImages.length > 0 && (
                <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {clientImages.map((img) => (
                    <div
                      key={img.id}
                      className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={img.dataUrl}
                        alt={img.name}
                        className="h-32 w-full object-cover"
                      />
                      <div className="space-y-2 p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-xs font-semibold text-slate-800">
                              {img.name}
                            </p>
                            <p className="text-[11px] text-slate-500">
                              {formatBytes(img.originalBytes)} →{" "}
                              {formatBytes(img.compressedBytes)}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => removeClientImage(img.id)}
                            aria-label={`Remove ${img.name}`}
                            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-950"
                          >
                            ×
                          </button>
                        </div>
                        <select
                          value={img.role}
                          onChange={(e) =>
                            updateClientImageRole(
                              img.id,
                              e.target.value as ClientImageRole,
                            )
                          }
                          className="w-full rounded-xl border border-slate-200 bg-white px-2 py-2 text-xs text-slate-700 outline-none focus:border-slate-400 focus:ring-4 focus:ring-slate-900/10"
                        >
                          <option value="hero">Hero</option>
                          <option value="services">Services</option>
                          <option value="team">Team</option>
                          <option value="gallery">Gallery</option>
                          <option value="general">General</option>
                        </select>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className={activeStepId === "inspiration" ? "" : "hidden"}>
              <label className="mb-2 block text-sm font-semibold text-slate-800">
                Inspiration screenshots for the whole site (optional)
              </label>
              <input
                type="file"
                accept="image/*"
                multiple
                disabled={screenshots.length >= MAX_SCREENSHOTS}
                onChange={handleScreenshotChange}
                className="block w-full cursor-pointer rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-3 text-sm text-slate-700 shadow-sm transition file:mr-3 file:rounded-xl file:border-0 file:bg-slate-950 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:border-slate-400 hover:file:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              />
              <p className="mt-1 text-xs text-slate-500">
                Up to {MAX_SCREENSHOTS} images. Large files are compressed
                before sending; these remain the strongest visual reference for
                the generator.
              </p>
              {screenshotError && (
                <p className="mt-1 text-xs text-red-600">{screenshotError}</p>
              )}
              {screenshots.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-3">
                  {screenshots.map((s, i) => (
                    <div
                      key={`${s.name}-${i}`}
                      className="group relative h-24 w-32 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={s.dataUrl}
                        alt={s.name}
                        className="h-full w-full object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => removeScreenshot(i)}
                        aria-label={`Remove ${s.name}`}
                        className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded-full bg-slate-950/80 text-white opacity-0 shadow transition hover:bg-slate-950 group-hover:opacity-100"
                      >
                        ×
                      </button>
                      <span className="absolute inset-x-0 bottom-0 truncate bg-slate-950/70 px-1.5 py-0.5 text-[10px] text-white">
                        {s.name}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div
              className={`grid grid-cols-1 gap-4 md:grid-cols-3 ${
                activeStepId === "basics" ? "" : "hidden"
              }`}
            >
              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-800">
                  Client name
                </label>
                <input
                  type="text"
                  required
                  placeholder="Acme Coffee Roasters"
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-slate-400 focus:ring-4 focus:ring-slate-900/10"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-800">
                  Brand colors (optional)
                </label>
                <input
                  type="text"
                  placeholder="#FF6600, #003366, #FFFFFF"
                  pattern="^\s*#?[0-9A-Fa-f]{6}(\s*,\s*#?[0-9A-Fa-f]{6})*\s*$"
                  value={brandColor}
                  onChange={(e) => setBrandColor(e.target.value)}
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-slate-400 focus:ring-4 focus:ring-slate-900/10"
                />
                <p className="mt-1 text-xs text-slate-500">
                  One hex, or several comma-separated. Listed first = treated as
                  primary.
                </p>
              </div>

              <div className="md:col-span-1">
                <label className="mb-2 block text-sm font-semibold text-slate-800">
                  Logo
                </label>
                <input
                  type="file"
                  accept="image/*"
                  required
                  onChange={handleLogoChange}
                  className="block w-full cursor-pointer rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-3 text-sm text-slate-700 shadow-sm transition file:mr-3 file:rounded-xl file:border-0 file:bg-slate-950 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:border-slate-400 hover:file:bg-slate-800"
                />
                {logoFileName && (
                  <p className="mt-1 text-xs text-slate-500 truncate">
                    {logoFileName}
                  </p>
                )}
                <fieldset className="mt-3">
                  <legend className="text-xs font-medium text-slate-600">
                    Logo works best on
                  </legend>
                  <div className="mt-1.5 flex gap-3 text-xs text-slate-700">
                    {(["light", "dark", "either"] as const).map((opt) => (
                      <label
                        key={opt}
                        className="inline-flex items-center gap-1.5"
                      >
                        <input
                          type="radio"
                          name="logoBackground"
                          value={opt}
                          checked={logoBackground === opt}
                          onChange={() => setLogoBackground(opt)}
                        />
                        {opt === "light"
                          ? "light bg"
                          : opt === "dark"
                            ? "dark bg"
                            : "either"}
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
            </div>

            {activeStepId === "generate" && (
              <div className="rounded-2xl border border-slate-200 bg-white/70 p-4 sm:p-5">
                <div className="mb-4">
                  <h3 className="text-sm font-semibold tracking-tight text-slate-900">
                    Ready to generate
                  </h3>
                  <p className="mt-1 text-xs text-slate-500">
                    Quick review before premium generation starts.
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2 lg:grid-cols-3">
                  <div className="rounded-2xl border border-slate-200 bg-white p-3">
                    <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-400">
                      Client
                    </p>
                    <p className="mt-1 font-semibold text-slate-900">
                      {clientName.trim() || "Missing client name"}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {currentSite.trim() || "No current site provided"}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-white p-3">
                    <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-400">
                      Brand assets
                    </p>
                    <p className="mt-1 font-semibold text-slate-900">
                      {logoDataUrl ? "Logo uploaded" : "Missing logo"}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {brandColor.trim() || "No color hints"}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-white p-3">
                    <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-400">
                      Inspiration
                    </p>
                    <p className="mt-1 font-semibold text-slate-900">
                      {urls.filter((u) => u.trim()).length} URL
                      {urls.filter((u) => u.trim()).length === 1 ? "" : "s"}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {screenshots.length} screenshot
                      {screenshots.length === 1 ? "" : "s"}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-white p-3">
                    <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-400">
                      Client photos
                    </p>
                    <p className="mt-1 font-semibold text-slate-900">
                      {clientImages.length} image
                      {clientImages.length === 1 ? "" : "s"}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {clientImages.some((img) => img.role === "hero")
                        ? "Hero image tagged"
                        : "No hero image tagged"}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-white p-3">
                    <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-400">
                      Direction
                    </p>
                    <p className="mt-1 font-semibold text-slate-900">
                      {projectBrief.trim() ? "Brief included" : "No brief"}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {styleNotes.trim() || goals.trim() || "No extra style notes"}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-white p-3">
                    <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-400">
                      Form
                    </p>
                    <p className="mt-1 font-semibold text-slate-900">
                      {selectedFormOption.label}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {formRequirement === "none"
                        ? "No Resend form needed"
                        : formDetails.trim() || "Default fields"}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-white p-3">
                    <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-400">
                      Engine
                    </p>
                    <p className="mt-1 font-semibold text-slate-900">
                      {providerModelLabel(generationProvider)}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      Firecrawl first, provider fallback
                    </p>
                  </div>
                </div>
              </div>
            )}

            <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center">
              <button
                type="button"
                onClick={() => goToStep(currentStep - 1)}
                disabled={currentStep === 0 || isLoading}
                className="inline-flex items-center justify-center rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:text-slate-950 disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Back
              </button>
              {!isLastStep && (
                <button
                  type="button"
                  onClick={goNext}
                  disabled={!stepReady || isLoading}
                  className="inline-flex items-center justify-center rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-slate-950/20 transition hover:-translate-y-0.5 hover:bg-slate-800 disabled:translate-y-0 disabled:cursor-not-allowed disabled:bg-slate-400 disabled:shadow-none"
                >
                  Next
                </button>
              )}
              <button
                type="submit"
                disabled={isLoading || !canLeaveBasics || !canLeaveInspiration}
                className={`inline-flex items-center justify-center rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-slate-950/20 transition hover:-translate-y-0.5 hover:bg-slate-800 disabled:translate-y-0 disabled:cursor-not-allowed disabled:bg-slate-400 disabled:shadow-none ${
                  isLastStep ? "" : "hidden"
                }`}
              >
                {isLoading
                  ? `Generating… ${elapsedSec}s elapsed`
                  : mockups.length === 3
                    ? "Generate Again"
                    : "Generate Mockups"}
              </button>
              {isLoading && (
                <span className="text-sm leading-6 text-slate-500">
                  {generationStage || "Starting premium generation"} with{" "}
                  {generationProvider === "openai" ? "OpenAI" : "Claude"}.
                  This can take several minutes in premium mode.
                </span>
              )}
              {!stepReady && !isLoading && nextBlockedMessage && (
                <span className="text-sm leading-6 text-amber-700">
                  {nextBlockedMessage}
                </span>
              )}
            </div>

            {error && (
              <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                {error}
              </div>
            )}
          </div>
        </form>

        {mockups.length === 3 && (
          <section className="mt-12">
            <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                  Results
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  Review each generated homepage at a wider, easier-to-scan
                  preview size.
                </p>
              </div>
              <button
                type="submit"
                form="generate-form"
                disabled={isLoading || exportingIndex !== null}
                className="inline-flex items-center justify-center rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-slate-950/20 transition hover:-translate-y-0.5 hover:bg-slate-800 disabled:translate-y-0 disabled:cursor-not-allowed disabled:bg-slate-400 disabled:shadow-none"
              >
                {isLoading
                  ? `Generating… ${elapsedSec}s elapsed`
                  : "Generate Again"}
              </button>
            </div>
            {generationMeta && (
              <div className="mb-5 grid grid-cols-1 gap-3 rounded-2xl border border-white/70 bg-white/80 p-4 text-sm shadow-sm md:grid-cols-3">
                <div>
                  <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-400">
                    Research
                  </p>
                  <p className="mt-1 font-semibold capitalize text-slate-900">
                    {generationMeta.usedResearchSource.replace("-", " ")}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-400">
                    Provider
                  </p>
                  <p className="mt-1 font-semibold text-slate-900">
                    {providerModelLabel(
                      generationMeta.usedProvider,
                      generationMeta.usedModel,
                    )}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {[
                      generationMeta.usedReasoningMode,
                      generationMeta.usedReasoningEffort
                        ? `${generationMeta.usedReasoningEffort} effort`
                        : undefined,
                      generationMeta.usedServiceTier
                        ? `${generationMeta.usedServiceTier} processing`
                        : undefined,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "Premium reasoning"}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-400">
                    QA scores
                  </p>
                  <p className="mt-1 font-semibold text-slate-900">
                    {generationMeta.qaReports.length > 0
                      ? generationMeta.qaReports
                          .map((qa) => Math.round(qa.score))
                          .join(" / ")
                      : "Not available"}
                  </p>
                </div>
              </div>
            )}
            {exportError && (
              <div className="mb-5 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                {exportError}
              </div>
            )}
            {shareError && shareModalIndex === null && (
              <div className="mb-5 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                {shareError}
              </div>
            )}
            <div className="mb-5 flex flex-wrap items-center gap-3">
              <span className="text-xs font-medium uppercase tracking-[0.2em] text-slate-400">
                Preview
              </span>
              <div className="inline-flex rounded-2xl border border-slate-200 bg-white p-1 text-sm shadow-sm">
                {(
                  [
                    { id: "mobile", label: "Mobile · 375" },
                    { id: "tablet", label: "Tablet · 768" },
                    { id: "desktop", label: "Desktop" },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setPreviewWidth(opt.id)}
                    className={`rounded-xl px-3 py-1.5 text-sm font-medium transition ${
                      previewWidth === opt.id
                        ? "bg-slate-950 text-white shadow-sm"
                        : "text-slate-600 hover:text-slate-950"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-1 gap-8">
              {mockups.map((m, i) => (
                <div
                  key={i}
                  className="overflow-hidden rounded-3xl border border-white/70 bg-white/90 shadow-xl shadow-slate-200/80 backdrop-blur"
                >
                  <div className="flex flex-col gap-3 border-b border-slate-200/80 bg-white/80 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-400">
                        Concept {i + 1}
                      </p>
                      <h3 className="mt-1 text-lg font-semibold text-slate-950">
                        {m.name}
                      </h3>
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <button
                        type="button"
                        onClick={() => handleUseThisDesign(m, i)}
                        disabled={exportingIndex !== null}
                        className="inline-flex items-center justify-center rounded-2xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-slate-800 disabled:translate-y-0 disabled:cursor-not-allowed disabled:bg-slate-400 disabled:shadow-none"
                      >
                        {exportingIndex === i ? "Bundling…" : "Use This Design"}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleCreateShareLink(i, m)}
                        disabled={
                          exportingIndex !== null || sharingIndex !== null
                        }
                        className="inline-flex items-center justify-center rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0"
                      >
                        {sharingIndex === i
                          ? "Creating link…"
                          : shareLinks[i]
                            ? "Show share link"
                            : "Share Link"}
                      </button>
                      <button
                        type="button"
                        onClick={() => downloadMockup(m)}
                        disabled={exportingIndex !== null}
                        className="inline-flex items-center justify-center rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0"
                      >
                        Download HTML
                      </button>
                    </div>
                  </div>
                  <div className="flex justify-center bg-slate-100">
                    <iframe
                      title={m.name}
                      srcDoc={m.html}
                      sandbox="allow-scripts"
                      style={
                        previewWidth === "desktop"
                          ? undefined
                          : {
                              width: previewWidth === "mobile" ? 375 : 768,
                              maxWidth: "100%",
                            }
                      }
                      className={`h-[760px] bg-white lg:h-[900px] ${
                        previewWidth === "desktop" ? "w-full" : ""
                      }`}
                    />
                  </div>
                  <div className="border-t border-slate-200/80 bg-white/90 p-4 sm:p-5">
                    <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-white to-slate-50 p-3 shadow-sm sm:p-4">
                      <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                        <div>
                          <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-400">
                            Targeted edit
                          </p>
                          <h4 className="mt-1 text-sm font-semibold text-slate-950">
                            Refine this design
                          </h4>
                        </div>
                        {refineReports[i] && (
                          <span
                            className={`inline-flex w-fit rounded-full px-2.5 py-1 text-xs font-medium ${
                              refineReports[i].pass
                                ? "bg-emerald-50 text-emerald-700"
                                : "bg-amber-50 text-amber-700"
                            }`}
                          >
                            {refineReports[i].pass
                              ? "QA passed"
                              : "QA notes available"}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-col gap-3">
                        <textarea
                          rows={3}
                          value={refineInstructions[i] ?? ""}
                          onChange={(e) =>
                            setRefineInstructions((prev) => ({
                              ...prev,
                              [i]: e.target.value,
                            }))
                          }
                          placeholder="Keep everything else the same, but make the header sticky with a white background and a larger logo."
                          className="min-h-[92px] flex-1 resize-y rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm leading-6 text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-slate-400 focus:ring-4 focus:ring-slate-900/10"
                        />
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <p className="text-xs leading-5 text-slate-500">
                            This updates only Concept {i + 1}. Good for small
                            changes like header style, CTA copy, spacing, color
                            mood, or swapping emphasis between sections.
                          </p>
                          <button
                            type="button"
                            onClick={() => handleRefineMockup(i, m)}
                            disabled={
                              refiningIndex !== null ||
                              !(refineInstructions[i] ?? "").trim()
                            }
                            className="inline-flex shrink-0 items-center justify-center rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-slate-800 disabled:translate-y-0 disabled:cursor-not-allowed disabled:bg-slate-400 disabled:shadow-none"
                          >
                            {refiningIndex === i ? "Refining…" : "Refine Design"}
                          </button>
                        </div>
                      </div>
                      {refineErrors[i] && (
                        <p className="mt-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                          {refineErrors[i]}
                        </p>
                      )}
                      {refineReports[i]?.issues?.length > 0 && (
                        <p className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                          QA note: {refineReports[i].issues.join(" ")}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      {shareModalIndex !== null && shareLinks[shareModalIndex] && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 px-4 backdrop-blur-sm"
          onClick={closeShareModal}
        >
          <div
            className="w-full max-w-lg rounded-3xl border border-white/70 bg-white/95 p-6 shadow-xl shadow-slate-950/20 backdrop-blur"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-400">
                  Concept {shareModalIndex + 1}
                </p>
                <h3 className="mt-1 text-lg font-semibold text-slate-950">
                  Share this preview
                </h3>
                <p className="mt-1 text-sm text-slate-500">
                  Anyone with this link can view the demo on a phone or
                  computer. Link expires{" "}
                  {formatExpiry(shareLinks[shareModalIndex].expiresAt)}.
                </p>
              </div>
              <button
                type="button"
                onClick={closeShareModal}
                aria-label="Close"
                className="inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-900"
              >
                ×
              </button>
            </div>
            <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2">
              <input
                type="text"
                readOnly
                value={shareLinks[shareModalIndex].url}
                onFocus={(e) => e.currentTarget.select()}
                className="min-w-0 flex-1 bg-transparent text-sm text-slate-900 outline-none"
              />
              <button
                type="button"
                onClick={() =>
                  copyShareLink(shareLinks[shareModalIndex!].url)
                }
                className="inline-flex shrink-0 items-center justify-center rounded-xl bg-slate-950 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-slate-800"
              >
                {shareLinkCopied ? "Copied!" : "Copy link"}
              </button>
            </div>
            {shareError && (
              <p className="mt-3 text-xs text-red-600">{shareError}</p>
            )}
            <p className="mt-4 text-xs text-slate-500">
              Tip: paste it into an email or text message — the client taps it
              on their phone and sees the demo full-screen.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

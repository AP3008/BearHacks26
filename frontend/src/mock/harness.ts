import type { GemmaFlags, NewRequest, Section, SectionType } from "../types";

export function isMockMode(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("mock") === "1";
}

function dispatch(data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { data }));
}

const SAMPLE_SYSTEM = `You are Claude Code, Anthropic's official CLI for Claude. You are an interactive agent that helps users with software engineering tasks.

# Tone and style
- Concise, direct.
- Show your work via tool calls; minimize prose.

# Tools
You have access to a set of tools you can use to answer the user's question. Use them to read files, search the codebase, run commands, and edit code.`;

const SAMPLE_USER = `Refactor the auth middleware in src/middleware/auth.ts to remove the legacy session token handling. We just got a compliance flag from legal — we cannot store unhashed session tokens anywhere. Replace the storage layer with the new tokenStore.put(hash) API in src/lib/tokenStore.ts.`;

const SAMPLE_ASSISTANT = `I'll read the existing middleware first so I can see the surface area, then refactor it to call the new \`tokenStore.put\` API.`;

const SAMPLE_TOOL_CALL = `{
  "name": "read_file",
  "input": { "path": "src/middleware/auth.ts" }
}`;

const SAMPLE_TOOL_OUTPUT = `import { Request, Response, NextFunction } from "express";
import { sessions } from "../legacy/sessionStore";

// LEGACY: stores raw token in process memory. This is the path that fails
// the compliance audit because tokens are not hashed at rest.
export function authMiddleware(req: Request, _res: Response, next: NextFunction) {
  const token = req.headers["authorization"]?.replace("Bearer ", "") ?? "";
  sessions.set(token, { issuedAt: Date.now(), userId: extractUser(token) });
  (req as any).sessionToken = token;
  next();
}

function extractUser(token: string): string {
  const [, payload] = token.split(".");
  if (!payload) return "anonymous";
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    return decoded.sub ?? "anonymous";
  } catch {
    return "anonymous";
  }
}

// (Repeats: helper duplication continues for ~120 more lines...)
`.repeat(3);

const PRICE_PER_1K_INPUT = 0.003;

function makeSection(
  index: number,
  sectionType: SectionType,
  rawContent: string,
): Section {
  const tokenCount = Math.max(1, Math.ceil(rawContent.length / 4));
  const cost = (tokenCount / 1000) * PRICE_PER_1K_INPUT;
  const contentPreview = rawContent.slice(0, 80).replace(/\s+/g, " ");
  return { index, sectionType, tokenCount, cost, contentPreview, rawContent };
}

function smallFixture(): NewRequest {
  const sections: Section[] = [
    makeSection(0, "system", SAMPLE_SYSTEM),
    makeSection(1, "user", SAMPLE_USER),
    makeSection(2, "assistant", SAMPLE_ASSISTANT),
    makeSection(3, "tool_call", SAMPLE_TOOL_CALL),
    makeSection(4, "tool_output", SAMPLE_TOOL_OUTPUT),
    makeSection(
      5,
      "assistant",
      "Got it — I have the file. The compliance issue is the in-memory `sessions.set(token, ...)` call. Let me replace it with the hashed `tokenStore.put(hash)` API and also drop the duplicated `extractUser` helper.",
    ),
  ];
  let totalTokens = 0;
  let totalCost = 0;
  for (const s of sections) {
    totalTokens += s.tokenCount;
    totalCost += s.cost;
  }
  return {
    type: "new_request",
    requestId: `mock-small-${Date.now()}`,
    sections,
    totalTokens,
    totalCost,
    model: "claude-sonnet-4-6",
    held: true,
  };
}

function largeFixture(barCount = 200): NewRequest {
  const types: SectionType[] = ["user", "assistant", "tool_call", "tool_output"];
  const sections: Section[] = [makeSection(0, "system", SAMPLE_SYSTEM)];
  for (let i = 1; i <= barCount; i++) {
    const type = types[(i - 1) % types.length];
    // Vary token sizes so the chart has visible peaks and valleys.
    const noise = Math.sin(i * 0.6) * 0.5 + Math.cos(i * 0.21) * 0.5;
    const baseLen = type === "tool_output" ? 1800 : type === "user" ? 240 : 700;
    const len = Math.max(40, Math.floor(baseLen * (1 + noise * 0.85)));
    const content = `# Section ${i} (${type})\n${"lorem ipsum dolor sit amet ".repeat(
      Math.ceil(len / 26),
    )}`;
    sections.push(makeSection(i, type, content));
  }
  let totalTokens = 0;
  let totalCost = 0;
  for (const s of sections) {
    totalTokens += s.tokenCount;
    totalCost += s.cost;
  }
  return {
    type: "new_request",
    requestId: `mock-large-${Date.now()}`,
    sections,
    totalTokens,
    totalCost,
    model: "claude-sonnet-4-6",
    held: true,
  };
}

function gemmaFixture(req: NewRequest): GemmaFlags {
  // Flag the largest tool_output and pick a believable highlight range inside.
  const targets = req.sections
    .filter((s) => s.sectionType === "tool_output")
    .sort((a, b) => b.tokenCount - a.tokenCount)
    .slice(0, 2);
  return {
    type: "gemma_flags",
    requestId: req.requestId,
    flags: targets.map((s, i) => {
      const duplicate = findRepeatedBlockRange(s.rawContent);
      return {
        sectionIndex: s.index,
        severity: i === 0 ? "high" : "medium",
        reason:
          duplicate != null
            ? "Duplicate repeated block. Removing this whole repeated block preserves the surrounding snippet."
            : "Likely redundant tool output. Review before trimming; no automatic removal range is suggested.",
        highlights: duplicate ? [duplicate] : [],
      };
    }),
  };
}

function findRepeatedBlockRange(
  text: string,
): { start: number; end: number } | null {
  const marker = "import { Request, Response, NextFunction } from \"express\";";
  const first = text.indexOf(marker);
  if (first === -1) return null;
  const second = text.indexOf(marker, first + marker.length);
  if (second === -1) return null;
  const third = text.indexOf(marker, second + marker.length);
  return {
    start: second,
    end: third === -1 ? text.length : third,
  };
}

function mountDevControls(onLoad: (size: "small" | "large") => void) {
  const host = document.createElement("div");
  host.className = "mock-dev-controls";
  host.innerHTML = `
    <button data-size="small">Small fixture</button>
    <button data-size="large">200-bar fixture</button>
  `;
  host.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const size = t.dataset.size as "small" | "large" | undefined;
    if (size) onLoad(size);
  });
  document.body.appendChild(host);
  return () => host.remove();
}

export function installMockHarness(): () => void {
  const load = (size: "small" | "large") => {
    const req = size === "small" ? smallFixture() : largeFixture();
    dispatch(req);
    // Delay Gemma flags to mimic the 2–8s analysis window.
    window.setTimeout(() => dispatch(gemmaFixture(req)), 2400);
  };

  // Boot with the small fixture so first paint has something useful.
  const bootTimer = window.setTimeout(() => load("small"), 60);
  const cleanup = mountDevControls(load);

  return () => {
    window.clearTimeout(bootTimer);
    cleanup();
  };
}

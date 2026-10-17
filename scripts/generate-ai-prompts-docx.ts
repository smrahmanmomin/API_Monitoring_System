/**
 * Generates AI_Prompts.docx at the repository root (assignment §9).
 *
 *   npm run docs:prompts
 *
 * The runtime prompts are imported from the backend source, so the document always matches
 * the code that actually runs. The implementation prompt is read verbatim from
 * docs/prompts/implementation-prompt.md.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import {
  ALERT_SYSTEM_PROMPT,
  PROMPT_VERSION,
  buildAlertUserPrompt,
  buildRepairPrompt,
} from '../backend/src/services/ai/prompts/alertPrompt.v1.js';
import { DEFAULT_THRESHOLDS } from '../backend/src/config/thresholds.js';
import { monitorEventSchema, toMonitoringEvent } from '../backend/src/schemas/monitorEvent.schema.js';
import { buildEvidence } from '../backend/src/services/alerts/evidence.js';
import { evaluateEvent } from '../backend/src/services/monitoring/ruleEngine.js';
import type { AlertContext } from '../backend/src/services/ai/types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MONO = 'Consolas';

// ── Building blocks ─────────────────────────────────────────────────────────

const heading = (text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel] = HeadingLevel.HEADING_1) =>
  new Paragraph({ text, heading: level, spacing: { before: 280, after: 120 } });

/** Plain paragraph with **bold** and `code` inline markup. */
function para(text: string, options: { bullet?: boolean; numbered?: boolean; italics?: boolean } = {}): Paragraph {
  const runs: TextRun[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > last) runs.push(new TextRun({ text: text.slice(last, match.index), italics: options.italics }));
    const token = match[0];
    runs.push(
      token.startsWith('**')
        ? new TextRun({ text: token.slice(2, -2), bold: true, italics: options.italics })
        : new TextRun({ text: token.slice(1, -1), font: MONO, size: 19 }),
    );
    last = match.index! + token.length;
  }
  if (last < text.length) runs.push(new TextRun({ text: text.slice(last), italics: options.italics }));
  return new Paragraph({
    children: runs,
    spacing: { after: 100 },
    ...(options.bullet ? { bullet: { level: 0 } } : {}),
    ...(options.numbered ? { numbering: { reference: 'numbers', level: 0 } } : {}),
  });
}

/** Monospace block in a shaded single-cell table (keeps whitespace and line breaks). */
function codeBlock(text: string): Table {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: 'C9D3D6' },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: 'C9D3D6' },
      left: { style: BorderStyle.SINGLE, size: 4, color: 'C9D3D6' },
      right: { style: BorderStyle.SINGLE, size: 4, color: 'C9D3D6' },
      insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F2F5F6' },
            margins: { top: 100, bottom: 100, left: 140, right: 140 },
            children: lines.map(
              (line) => new Paragraph({ children: [new TextRun({ text: line.length > 0 ? line : ' ', font: MONO, size: 17 })], spacing: { after: 0 } }),
            ),
          }),
        ],
      }),
    ],
  });
}

function table(rows: string[][]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(
      (cells, i) =>
        new TableRow({
          tableHeader: i === 0,
          children: cells.map(
            (cell) =>
              new TableCell({
                margins: { top: 60, bottom: 60, left: 100, right: 100 },
                ...(i === 0 ? { shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'DCECEC' } } : {}),
                children: [i === 0 ? new Paragraph({ children: [new TextRun({ text: cell, bold: true })] }) : para(cell)],
              }),
          ),
        }),
    ),
  });
}

/** Minimal Markdown → DOCX for the verbatim implementation prompt (headings, lists, code fences, rules). */
function markdownBlocks(markdown: string): Array<Paragraph | Table> {
  const blocks: Array<Paragraph | Table> = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.startsWith('```')) {
      const code: string[] = [];
      for (i += 1; i < lines.length && !lines[i]!.startsWith('```'); i += 1) code.push(lines[i]!);
      blocks.push(codeBlock(code.join('\n')));
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const levels = [HeadingLevel.HEADING_2, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4];
      blocks.push(heading(h[2]!.replace(/\*\*/g, ''), levels[h[1]!.length - 1]));
      continue;
    }
    if (line.trim() === '---' || line.trim() === '') continue;
    const bullet = /^\s*-\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push(para(bullet[1]!, { bullet: true }));
      continue;
    }
    const numbered = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    if (numbered) {
      blocks.push(para(`${numbered[1]}. ${numbered[2]}`));
      continue;
    }
    blocks.push(para(line));
  }
  return blocks;
}

// ── Example input built by the real code path ───────────────────────────────

function exampleContext(): AlertContext {
  const event = toMonitoringEvent(
    monitorEventSchema.parse({ api_name: 'AppointmentAPI', response_time_ms: 5500, status_code: 500, records_returned: 0, checked_at: '2026-10-16T19:34:38Z' }),
  );
  const findings = evaluateEvent(event, DEFAULT_THRESHOLDS, new Date('2026-10-16T19:34:38.120Z'));
  const finding = findings[0]!;
  return {
    apiName: event.apiName,
    anomalyType: finding.type,
    severity: finding.severity,
    occurrenceCount: 1,
    firstSeenAt: event.checkedAt.toISOString(),
    lastSeenAt: event.checkedAt.toISOString(),
    evidence: buildEvidence(event, finding, findings, { expectedMinRecords: undefined, latencyThresholdMs: DEFAULT_THRESHOLDS.latencyThresholdMs }),
  };
}

// ── Document ────────────────────────────────────────────────────────────────

async function main() {
  const implementationPrompt = await readFile(path.join(ROOT, 'docs/prompts/implementation-prompt.md'), 'utf8');

  const children: Array<Paragraph | Table> = [
    new Paragraph({ text: 'AI Prompts', heading: HeadingLevel.TITLE, alignment: AlignmentType.LEFT }),
    para('Intelligent API Monitoring & AI-Powered Alert System — documentation of every AI prompt used to build the project and every prompt the application sends to an LLM at runtime.', { italics: true }),
    para(`Runtime prompt version: **${PROMPT_VERSION}**. Generated from source by \`npm run docs:prompts\` (scripts/generate-ai-prompts-docx.ts), so the runtime prompts below are exactly what the code sends.`),

    heading('1. Overview: where AI is used'),
    table([
      ['Prompt', 'Used by', 'Where in the code', 'Purpose'],
      ['Implementation prompt (section 2)', 'Claude Code (AI coding assistant) during development', 'Not part of the application', 'Instructed the AI assistant to design, implement, test and document the project'],
      ['Alert system prompt (section 3)', 'Backend → LLM provider', 'backend/src/services/ai/prompts/alertPrompt.v1.ts (ALERT_SYSTEM_PROMPT)', 'Sets role, rules and JSON output contract for alert explanations'],
      ['Alert input template (section 4)', 'Backend → LLM provider', 'alertPrompt.v1.ts (buildAlertUserPrompt / buildAlertEvidencePayload)', 'Delivers one deterministic finding as delimited JSON evidence'],
      ['Repair prompt (section 5)', 'Backend → LLM provider', 'alertPrompt.v1.ts (buildRepairPrompt), called from openAiCompatibleProvider.ts', 'One recovery attempt when the reply is not valid JSON or fails schema validation'],
    ]),

    heading('2. Implementation prompt (AI-assisted development)'),
    para('The project was built with Claude Code (Anthropic) acting as the coding assistant. The user supplied the assignment PDF ("Ai Automation Task (1) (1).pdf") and the master prompt below, reproduced verbatim. It drove the inspection, planning, implementation, testing and documentation of the whole repository.'),
    para('Clarifications given by the user during planning (answers to the assistant\'s questions):', {}),
    para('LLM provider: "research for something free" → an OpenAI-compatible provider abstraction defaulting to the Groq free tier (Gemini, OpenRouter, Ollama and OpenAI work by changing environment variables).', { bullet: true }),
    para('Database: Docker Compose PostgreSQL (recommended option chosen).', { bullet: true }),
    para('Optional e-mail feature (assignment §7.4): "Yes, via Nodemailer SMTP".', { bullet: true }),
    para('Verbatim master prompt:', {}),
    ...markdownBlocks(implementationPrompt),

    heading('3. Runtime LLM system prompt'),
    para('Sent as the `system` message with every alert-generation request. Model parameters: model `openai/gpt-oss-120b` on Groq by default, temperature 0.2, `max_tokens` 1200 (`LLM_MAX_OUTPUT_TOKENS`), `reasoning_effort` "low" for reasoning models (`LLM_REASONING_EFFORT`), `response_format: { type: "json_object" }`.'),
    codeBlock(ALERT_SYSTEM_PROMPT),

    heading('4. Alert-generation input template'),
    para('Sent as the `user` message. The evidence is produced deterministically by the rule engine and wrapped in <evidence> tags so the model treats it as data. Below is the exact message the application builds for the assignment example (AppointmentAPI, HTTP 500, 5500 ms, 0 records) — generated by running the real code:'),
    codeBlock(buildAlertUserPrompt(exampleContext())),
    para('Fields sent (data minimisation): API name, anomaly type, rule-engine severity and message, observed/expected values, HTTP status, response time, record count/issue, configured thresholds, other anomaly types in the same check, occurrence count and first/last-seen timestamps. Never sent: response bodies, patient data, headers, tokens, credentials or free-text from clients (unknown request fields are rejected at validation).'),

    heading('5. Structured-output recovery (repair) prompt'),
    para('If the first reply is not valid JSON or fails the Zod schema, or the provider itself rejects the reply as invalid JSON (Groq error code json_validate_failed), the provider sends this message once, appending the model\'s reply when there is one. If the second reply is still invalid, the deterministic fallback text is kept. Template (the placeholder is replaced by the actual validation error):'),
    codeBlock(buildRepairPrompt('<validation error, e.g. "reply did not match the schema (recommended_actions: Array must contain at least 1 element(s))">')),
    para('Expected output schema (validated with Zod in backend/src/services/ai/alertOutput.schema.ts; unknown keys are stripped):'),
    codeBlock('{\n  "title": string (3-120 chars),\n  "summary": string (10-1200 chars),\n  "possible_causes": string[] (1-4 items),\n  "recommended_actions": string[] (1-5 items)\n}'),

    heading('6. Prompt-design decisions and safeguards'),
    ...[
      '**Rules detect, the LLM explains.** The model never decides whether something is an anomaly; it receives one finding that already exists.',
      '**Severity is fixed by the rule engine.** The prompt forbids changing it, and any severity in the reply is discarded by the schema.',
      '**No fabrication.** The prompt forbids inventing metrics, logs, error messages, history or root causes; causes must be phrased as hypotheses.',
      '**Prompt-injection resistance.** Evidence is delimited, described as data, and comes from validated numeric/enum fields; free-text request fields are rejected before they could reach the prompt.',
      '**Structured output + validation.** JSON mode, a strict Zod schema, one repair attempt, then deterministic fallback.',
      '**Zero records nuance.** The prompt requires acknowledging that zero records can be legitimate, as the assignment requires.',
      '**Concise and specific.** Length limits per field and an explicit ban on generic advice keep alerts actionable.',
      '**Reliability.** Ingestion never waits for the LLM: alerts are stored with fallback text first and upgraded asynchronously; timeouts (15 s) and bounded SDK retries (2) handle transient errors and rate limits.',
      '**Transparency.** Every alert records `generation_source` (AI or FALLBACK), the model and the prompt version; the UI and e-mails show which one produced the text.',
      '**Privacy.** Only monitoring metadata leaves the server; the API key is server-side only and never logged.',
      '**Quota awareness.** The LLM is called for new alerts and severity escalations only, not for every repeat occurrence. Jobs run one at a time, and rate-limited jobs are retried after a delay (the Groq free tier allows about 8,000 tokens per minute).',
      '**Reasoning budget.** For reasoning models such as gpt-oss, `reasoning_effort` is set to low so hidden reasoning does not use up the output budget and truncate the JSON.',
    ].map((t) => para(t, { bullet: true })),
  ];

  const doc = new Document({
    creator: 'API Monitoring & Alert System',
    title: 'AI Prompts',
    description: 'Prompts used to build and run the Intelligent API Monitoring & AI-Powered Alert System',
    styles: { default: { document: { run: { font: 'Calibri', size: 21 } } } },
    numbering: { config: [{ reference: 'numbers', levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.START }] }] },
    sections: [{ children }],
  });

  const out = path.join(ROOT, 'AI_Prompts.docx');
  await writeFile(out, await Packer.toBuffer(doc));
  console.log(`Wrote ${out}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

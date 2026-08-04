import React from "react";
import * as ReactDOM from "react-dom";
import { marked } from "marked";
import {
  allowedReportUrl,
  canonicalReportUrl,
  filterAllowedReportLinks,
  sanitizeReportHtml
} from "../lib/report-links.js";
import {
  trialCollectionDescription,
  trialCoverageMessage
} from "../lib/trial-coverage.js";
import {
  allApprovedDrugsRendered,
  drugKeysMatch,
  injectApprovedTreatmentStubs
} from "../lib/drug-card-utils.js";
import { sanitizePublicText } from "../lib/public-language.js";
import { markdownToPlainText } from "../lib/markdown-to-text.js";
import {
  extractCitationUrls, resolveItemKind, resolveRepurposeSection, candidateDedupKey,
  REPURPOSE_LANE_COUNT, REPURPOSE_PER_LANE, REPURPOSE_SECTION_DISPLAY_CAP,
  REPURPOSE_RESEARCHED_LANE, REPURPOSE_MECHANISTIC_LANE, isPipelineProgramme
} from "../lib/repurpose-quality.js";
import { isGoogleSearchUrl, isDailyMedSearchUrl } from "../lib/citation-gate.js";
import { buildCanonicalReportModel } from "../lib/report-model.js";
import { approvedUpgradeUrl } from "../lib/upgrade-url.js";
import { classifyAccessProbeResponse } from "../lib/access-transition.js";
import {
  cachedCompletionForClipboard,
  normalizeTrialStudies,
  trialBooleanLabel
} from "../lib/report-surface.js";
import { buildBrowserResearchRequest } from "../lib/research-request.js";
import {
  profileClinicalPlaceholders,
  profileSafetyFields
} from "../lib/profile-field-config.js";

// Rows shown in the clinical-trials list and in exports. Kept modest: the
// full result set is a research dump, and every extra row also enlarges the
// payload handed to the synthesis step.
const linkLabelText = (value) =>
  String(value || '').replace(/\s*↗\s*$/, '').trim();

const TRIAL_ROW_DISPLAY_LIMIT = 25;

window.marked = marked;

const { useState, useRef, useEffect, useMemo, useCallback } = React;

const publicTextOrFallback = (value, fallback = 'This information is temporarily unavailable.') => {
  try { return sanitizePublicText(value); }
  catch { return fallback; }
};

const notifyUser = (message, kind = 'info') => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('mrt:user-feedback', {
    detail: { message: publicTextOrFallback(message), kind }
  }));
};

const useDialogAccessibility = (open, onClose) => {
  const dialogRef = useRef(null);
  const returnFocusRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement;
    const dialog = dialogRef.current;
    const focusable = () => [...(dialog?.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ) || [])];
    (focusable()[0] || dialog)?.focus();
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && onCloseRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = focusable();
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      returnFocusRef.current?.focus?.();
    };
  }, [open]);
  return dialogRef;
};

/* ==================== Access passcode gate ====================
   Dorothy explicitly required: "no one could stumble upon it and
   use it accidentally at this point." Implementation:

   1. Server side: every /api/* endpoint imports lib/access-gate.js
      and rejects with 401 + code='ACCESS_GATE_BLOCKED' unless the
      caller presents the configured passcode.
   2. Client side: the passcode is exchanged once for an HttpOnly,
      SameSite session cookie. JavaScript never stores or re-reads it.
      A fetch wrapper only dispatches an access-denied event when the
      server rejects a session.
   3. When the env var MRT_ACCESS_PASSCODE is unset the server is
      fail-open (so local dev + tests work). In that case the gate
      screen is skipped automatically — see probeAccessGate().
============================================================== */
const MRT_TERMS_VERSION = '2026-07-18-2';

/* Inline Terms of Use (mirrors docs/TERMS_OF_USE.md for the modal). */
const TERMS_OF_USE_SECTIONS = [
  { title: 'Made to help you learn — not medical advice',
    body: 'This tool gathers facts from medical journals and lists of clinical trials (research studies that test new treatments) to help you learn about your options. It is not medical advice. It does not give you a diagnosis or tell you what to do. It does not take the place of a licensed doctor or other trained health provider.' },
  { title: 'We are not your doctor',
    body: 'Using this site does not make us your doctor or care team. It does not start any kind of health-care relationship between you and the people who run this tool.' },
  { title: 'This tool does not meet HIPAA privacy rules',
    body: 'This is an early version of the tool. It does not follow HIPAA (the U.S. law that protects your health records). Please do not type names, birth dates, medical record numbers, addresses, phone numbers, or anything that could point to a real person. On-demand profile and chat text are sent to outside AI providers and condition or drug queries are sent to public medical-data services.' },
  { title: 'We cannot promise the AI is right',
    body: 'Medical research is hard to read and changes fast. AI summaries can be missing facts, out of date, or wrong. Sometimes the AI even makes up sources — links or papers that do not exist or do not back up what it says. We cannot promise the results are correct, complete, or right for you.' },
  { title: 'Please check the links and facts yourself',
    body: 'It is your job to check every source, link, trial, and fact before you trust it. Open the links (like PubMed and ClinicalTrials.gov) and talk over what you find with your care team.' },
  { title: 'Email alerts are saved on our server',
    body: 'If you sign up for email updates, we save your email address, condition, delivery schedule, and the limited health details you choose to include. We use a secure database when available and an email delivery service to send alerts. A subscription expires after at most 365 days unless renewed. A private link stored in your browser lets you download or delete that subscription. Do not include details that identify you directly.' },
  { title: 'On-demand profiles and alert data are handled differently',
    body: 'Your browser stores the on-demand profile, up to 50 floating-chat turns, alert email, and private alert-management links until you use Erase local data or clear browser storage. We do not save the on-demand profile to our database unless you separately submit fields for an alert.' },
  { title: 'Outside providers have separate rules',
    body: 'Anthropic generates reports. Perplexity, OpenAI, or xAI may check them when configured. PubMed/NCBI, Europe PMC, OpenAlex, ClinicalTrials.gov, openFDA, and Unpaywall receive the search terms needed to find sources. These outside services control how long they keep data, which companies help them process it, and whether account data may improve their systems. We cannot verify or guarantee those practices.' },
  { title: 'You must be 18 or older',
    body: 'You must be 18 years or older to use this tool. If you are younger, use it only with a parent or guardian who agrees to these terms for you.' },
  { title: 'No promises about the tool',
    body: 'This tool is provided “as is” and “as available,” with no promises of any kind, whether stated or implied. That includes no promise that it is fit to sell, fit for your purpose, or free of conflicts with the rights of others.' },
  { title: 'Limits on who is responsible',
    body: 'As much as the law allows, the people who run researchingmycondition.com and those who help build it are not responsible for any harm or loss that comes from using this tool or trusting what it shows you. This covers direct, indirect, and other kinds of damages.' }
];

const INTEGRITY_FLAGGED_PUBLISHER_EXAMPLES = [
  'OMICS International',
  'Hindawi (mass-retractions 2023–2024)',
  'Scientific Research Publishing (SciRP)',
  'Bentham Open / Bentham Science',
  'MedCrave Group',
  'Scholink',
  'IISTE',
  'Juniper Publishers'
];

const CHAT_SESSION_FOOTNOTE = 'Answers use this session\u2019s context. Submitted text is sent to configured AI providers. Those providers control how long they keep data and whether account data may improve their systems; check their current terms and your account settings.';

const TermsContext = React.createContext({ openTerms: () => {} });
const __mrtNativeFetch = window.fetch.bind(window);
const MRT_BROWSER_FETCH_TIMEOUT_MS = 300_000;
const MRT_GATE_FETCH_TIMEOUT_MS = 12_000;
const fetchGateRequest = async (input, init = {}) => {
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  const relayAbort = () => controller.abort(upstreamSignal.reason);
  if (upstreamSignal?.aborted) relayAbort();
  else upstreamSignal?.addEventListener('abort', relayAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new DOMException('Access check timed out.', 'TimeoutError'));
  }, MRT_GATE_FETCH_TIMEOUT_MS);
  try {
    return await __mrtNativeFetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    upstreamSignal?.removeEventListener('abort', relayAbort);
  }
};
const MRT_PAID_MODES = new Set([
  'research', 'repurpose', 'trials', 'chat', 'translate',
  'benchmark-models', 'validate', 'polish-report'
]);
const mrtIdempotencyKeys = new Map();
const billableFetchInit = (url, init) => {
  if (!/\/api\/research(?:$|\?)/.test(url) || String(init.method || 'GET').toUpperCase() !== 'POST') {
    return init;
  }
  let body;
  try { body = JSON.parse(String(init.body || '{}')); } catch { return init; }
  if (!MRT_PAID_MODES.has(String(body.mode || 'research'))) return init;
  const signature = String(init.body);
  const now = Date.now();
  let item = mrtIdempotencyKeys.get(signature);
  if (!item || item.expiresAt <= now) {
    item = {
      key: globalThis.crypto?.randomUUID?.() ||
        `mrt-${now}-${Math.random().toString(36).slice(2)}`,
      expiresAt: now + 10 * 60 * 1000
    };
    mrtIdempotencyKeys.set(signature, item);
  }
  const headers = new Headers(init.headers || {});
  if (!headers.has('X-Idempotency-Key')) headers.set('X-Idempotency-Key', item.key);
  return { ...init, headers };
};
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  const isApi = /^\/api\//.test(url) || /\/api\//.test(url);
  init = billableFetchInit(url, init);
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  const relayAbort = () => controller.abort(upstreamSignal.reason);
  if (upstreamSignal?.aborted) relayAbort();
  else upstreamSignal?.addEventListener('abort', relayAbort, { once: true });
  const timer = setTimeout(() => {
    const error = new DOMException(
      `Request timed out after ${MRT_BROWSER_FETCH_TIMEOUT_MS}ms`,
      'TimeoutError'
    );
    controller.abort(error);
  }, MRT_BROWSER_FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await __mrtNativeFetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    upstreamSignal?.removeEventListener('abort', relayAbort);
  }
  if (isApi && res.status === 401) {
    // Clone first so callers can still read the body.
    try {
      const clone = res.clone();
      const body = await clone.json().catch(() => null);
      if (body && body.code === 'ACCESS_GATE_BLOCKED') {
        window.dispatchEvent(new CustomEvent('mrt:access-denied'));
      }
    } catch {}
  }
  if (isApi && res.status === 428) {
    try {
      const clone = res.clone();
      const body = await clone.json().catch(() => null);
      if (body && body.code === 'TERMS_ACCEPTANCE_REQUIRED') {
        window.dispatchEvent(new CustomEvent('mrt:terms-required'));
      }
    } catch {}
  }
  return res;
};

const isLocalDevHost = () => {
  try {
    return /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  } catch { return false; }
};
const localApiDevHint =
  'Start the API from the project root: npm run dev (or vercel dev). Then open http://localhost:3000 — do not open index.html as a file. See README.';
if (typeof location !== 'undefined' && location.protocol === 'file:') {
  console.warn('[MRT] Opened as file:// — /api/* will not work. ' + localApiDevHint);
}

const formatApiError = (data, res) => {
  if (!data) return 'We could not complete that request. Please try again.';
  if (data.code === 'IDEMPOTENCY_KEY_REQUIRED' || data.code === 'IDEMPOTENCY_KEY_CONFLICT') {
    return 'This page is out of date. Refresh it once, then retry the saved report without running the search again.';
  }
  const raw = typeof data.error === 'string'
    ? data.error
    : (data.error?.message || data.message || '');
  if (/not_found_error|model:\s*claude-sonnet-4-20250514/i.test(raw)) {
    return 'The report-writing service is temporarily unavailable. Refresh the page and try again; the research already gathered is saved.';
  }
  if (/timeout|timed out|gateway/i.test(raw)) return 'The request took too long. Please try again.';
  if (res?.status === 429 || /rate|quota|limit/i.test(raw)) return 'The service is busy or your current search limit has been reached. Please try again later.';
  if (res?.status === 401 || res?.status === 403) return 'Your access could not be confirmed. Re-enter the private-preview passcode.';
  return 'We could not complete that request. Please try again.';
};

// Shared non-JSON / edge-error parser for all /api/research callers.
const parseApiJsonResponse = (res, raw, { timeoutMsg } = {}) => {
  let data;
  try { data = JSON.parse(raw); }
  catch {
    if (isLocalDevHost() && (res.status === 501 || res.status === 404)) {
      throw new Error(localApiDevHint);
    }
    if (res.status === 501) {
      throw new Error('The service is temporarily unavailable. Try again in one minute or contact support.');
    }
    const isTimeout = /FUNCTION_INVOCATION_TIMEOUT|An error occurred with your deployment|504|Gateway Time-out/i.test(raw);
    throw new Error(
      isTimeout
        ? (timeoutMsg || 'Server timeout. Try again in a moment.')
        : 'The service returned an unexpected response. Please try again.'
    );
  }
  return data;
};

/* ==================== Inline icon components ==================== */
const mkIcon = (paths) => ({ size = 20, color = 'currentColor', ...rest }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...rest}>
    {paths}
  </svg>
);
const Activity = mkIcon(<polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />);
const Brain = mkIcon(<>
  <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" />
  <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" />
</>);
const FileText = mkIcon(<>
  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
  <polyline points="14 2 14 8 20 8" />
  <line x1="16" y1="13" x2="8" y2="13" />
  <line x1="16" y1="17" x2="8" y2="17" />
</>);
const Search = mkIcon(<>
  <circle cx="11" cy="11" r="8" />
  <path d="m21 21-4.35-4.35" />
</>);
const TrendingUp = mkIcon(<>
  <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
  <polyline points="17 6 23 6 23 12" />
</>);
const AlertCircle = mkIcon(<>
  <circle cx="12" cy="12" r="10" />
  <line x1="12" y1="8" x2="12" y2="12" />
  <line x1="12" y1="16" x2="12.01" y2="16" />
</>);
const Mail = mkIcon(<>
  <rect x="2" y="4" width="20" height="16" rx="2" />
  <path d="m22 7-10 6L2 7" />
</>);
const Beaker = mkIcon(<>
  <path d="M4.5 3h15" />
  <path d="M6 3v16a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V3" />
  <path d="M6 14h12" />
</>);
const Sparkles = mkIcon(<>
  <path d="M12 3l1.9 4.6L18.5 9l-4.6 1.4L12 15l-1.9-4.6L5.5 9l4.6-1.4L12 3z" />
  <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z" />
</>);
const ShieldCheck = mkIcon(<>
  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  <path d="m9 12 2 2 4-4" />
</>);
const Book = mkIcon(<>
  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15z" />
  <path d="M4 19.5v0A2.5 2.5 0 0 0 6.5 22H20v-5" />
</>);
const Loader = mkIcon(<>
  <line x1="12" y1="2" x2="12" y2="6" />
  <line x1="12" y1="18" x2="12" y2="22" />
  <line x1="4.93" y1="4.93" x2="7.76" y2="7.76" />
  <line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
  <line x1="2" y1="12" x2="6" y2="12" />
  <line x1="18" y1="12" x2="22" y2="12" />
  <line x1="4.93" y1="19.07" x2="7.76" y2="16.24" />
  <line x1="16.24" y1="7.76" x2="19.07" y2="4.93" />
</>);
const Database = mkIcon(<>
  <ellipse cx="12" cy="5" rx="9" ry="3" />
  <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
  <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
</>);
const Download = mkIcon(<>
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
  <polyline points="7 10 12 15 17 10" />
  <line x1="12" y1="15" x2="12" y2="3" />
</>);
const Info = mkIcon(<>
  <circle cx="12" cy="12" r="10" />
  <line x1="12" y1="16" x2="12" y2="12" />
  <line x1="12" y1="8" x2="12.01" y2="8" />
</>);
const Languages = mkIcon(<>
  <path d="M5 8h6" />
  <path d="M4 12h4" />
  <path d="M9 4c0 4-2 8-5 10" />
  <path d="M8 4c0 4 2 8 5 10" />
  <path d="M14 10h7" />
  <path d="M17.5 4v14" />
  <path d="M14 18h7" />
</>);
const ExternalLink = mkIcon(<>
  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  <polyline points="15 3 21 3 21 9" />
  <line x1="10" y1="14" x2="21" y2="3" />
</>);
const CheckCircle = mkIcon(<>
  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
  <polyline points="22 4 12 14.01 9 11.01" />
</>);
const XCircle = mkIcon(<>
  <circle cx="12" cy="12" r="10" />
  <line x1="15" y1="9" x2="9" y2="15" />
  <line x1="9" y1="9" x2="15" y2="15" />
</>);
const Scales = mkIcon(<>
  <path d="M16 16l3-8 3 8c-2 1-4 1-6 0" />
  <path d="M2 16l3-8 3 8c-2 1-4 1-6 0" />
  <path d="M12 2v20" />
  <path d="M5 8h14" />
  <path d="M7 21h10" />
</>);
const Award = mkIcon(<>
  <circle cx="12" cy="8" r="7" />
  <polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88" />
</>);
const Lightbulb = mkIcon(<>
  <path d="M9 18h6" />
  <path d="M10 22h4" />
  <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14" />
</>);
const Flask = mkIcon(<>
  <path d="M10 2v7.31" />
  <path d="M14 9.3V1.99" />
  <path d="M8.5 2h7" />
  <path d="M14 9.3a6.5 6.5 0 1 1-4 0" />
</>);
const MessageCircle = mkIcon(<>
  <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
</>);
const Shield = mkIcon(<>
  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
</>);
const BookOpen = mkIcon(<>
  <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
  <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
</>);
const User = mkIcon(<>
  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
  <circle cx="12" cy="7" r="4" />
</>);
const LogIn = mkIcon(<>
  <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
  <polyline points="10 17 15 12 10 7" />
  <line x1="15" y1="12" x2="3" y2="12" />
</>);
const LogOut = mkIcon(<>
  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
  <polyline points="16 17 21 12 16 7" />
  <line x1="21" y1="12" x2="9" y2="12" />
</>);
const Settings = mkIcon(<>
  <circle cx="12" cy="12" r="3" />
  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
</>);
const HelpCircle = mkIcon(<>
  <circle cx="12" cy="12" r="10" />
  <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
  <line x1="12" y1="17" x2="12.01" y2="17" />
</>);
const ChevronDown = mkIcon(<>
  <polyline points="6 9 12 15 18 9" />
</>);
const ChevronUp = mkIcon(<>
  <polyline points="18 15 12 9 6 15" />
</>);
const AlertTriangle = mkIcon(<>
  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
  <line x1="12" y1="9" x2="12" y2="13" />
  <line x1="12" y1="17" x2="12.01" y2="17" />
</>);
const Sun = mkIcon(<>
  <circle cx="12" cy="12" r="4" />
  <path d="M12 2v2" /><path d="M12 20v2" />
  <path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" />
  <path d="M2 12h2" /><path d="M20 12h2" />
  <path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" />
</>);
const Moon = mkIcon(<>
  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
</>);
const Building = mkIcon(<>
  <rect x="4" y="2" width="16" height="20" rx="2" ry="2" />
  <path d="M9 22v-4h6v4" />
  <path d="M8 6h.01" /><path d="M16 6h.01" />
  <path d="M12 6h.01" /><path d="M12 10h.01" />
  <path d="M12 14h.01" /><path d="M16 10h.01" />
  <path d="M16 14h.01" /><path d="M8 10h.01" />
  <path d="M8 14h.01" />
</>);

/* ==================== Theme ==================== */
// Two palettes. Identity choices (why this isn't a ChatGPT / IBM
// Watson clone):
//   - Primary accent is a cyan that reads as "clinical instrument"
//     rather than the ChatGPT-green or corporate-IBM-blue we'd
//     get if we just grabbed default Tailwind slate/indigo.
//   - We carry a dedicated amber/burnt-orange "secondary" across
//     both modes for evidence-grade highlights (citation tags,
//     red-flag callouts). Two-tone identity separates us from
//     monochrome AI chat products.
//   - Light mode is cool near-white with a faint cyan panel wash
//     (NEJM-web feel) rather than pure white — premium clinical,
//     not ChatGPT sterile.
//
// The theme/panelStyle/inputStyle/labelStyle/btn identifiers are
// MUTABLE (let, not const) so we can flip palettes at runtime. The
// App component calls `applyThemeMode()` which rewires all of them
// in-place and triggers a re-render; every component reads these
// bindings fresh on every render, so styles follow automatically.
const DARK_PALETTE = {
  name: 'dark',
  bg: 'radial-gradient(ellipse at top, #0d2030 0%, #061018 55%, #030910 100%)',
  panel: 'rgba(34, 211, 238, 0.045)',
  panelSolid: 'rgba(16, 38, 56, 0.92)',
  border: 'rgba(125, 211, 252, 0.22)',
  accent: '#22d3ee',
  accentSoft: 'rgba(34, 211, 238, 0.14)',
  accentEdge: 'rgba(34, 211, 238, 0.35)',
  accentGlow: 'rgba(34, 211, 238, 0.22)',
  secondary: '#f59e0b',
  secondarySoft: 'rgba(245, 158, 11, 0.14)',
  text: '#eef5fa',
  textDim: '#b8cdd9',
  textBright: '#f5fafd',
  inputBg: 'rgba(15, 32, 39, 0.55)',
  inputBorder: 'rgba(34, 211, 238, 0.3)',
  rowStripe: 'rgba(15, 32, 39, 0.4)',
  ghostBg: 'rgba(34, 211, 238, 0.1)',
  ghostBorder: 'rgba(34, 211, 238, 0.35)',
  primaryText: '#04131a',
  green: '#34d399', yellow: '#fbbf24', red: '#f87171'
};
const LIGHT_PALETTE = {
  name: 'light',
  bg: 'radial-gradient(ellipse at top, #ffffff 0%, #eaf1f6 100%)',
  panel: 'rgba(14, 116, 144, 0.03)',
  panelSolid: '#ffffff',
  border: 'rgba(15, 23, 42, 0.14)',
  accent: '#0e7490',
  accentSoft: 'rgba(14, 116, 144, 0.09)',
  accentEdge: 'rgba(14, 116, 144, 0.32)',
  accentGlow: 'rgba(14, 116, 144, 0.2)',
  secondary: '#c2410c',
  secondarySoft: 'rgba(194, 65, 12, 0.09)',
  text: '#0f172a',
  textDim: '#475569',
  textBright: '#020617',
  inputBg: '#ffffff',
  inputBorder: 'rgba(14, 116, 144, 0.25)',
  rowStripe: 'rgba(241, 245, 249, 0.8)',
  ghostBg: 'rgba(14, 116, 144, 0.07)',
  ghostBorder: 'rgba(14, 116, 144, 0.3)',
  primaryText: '#ffffff',
  green: '#047857', yellow: '#b45309', red: '#b91c1c'
};
const buildPanelStyle = (t) => ({
  background: t.panel, borderRadius: 12,
  border: `1px solid ${t.border}`, padding: '1.5rem',
  backdropFilter: t.name === 'dark' ? 'blur(10px)' : 'none',
  boxShadow: t.name === 'light' ? '0 1px 2px rgba(15, 23, 42, 0.04)' : 'none'
});
const buildInputStyle = (t) => ({
  padding: '0.75rem', background: t.inputBg,
  border: `1px solid ${t.inputBorder}`, borderRadius: 8,
  color: t.text, fontSize: '0.95rem', fontFamily: 'inherit', width: '100%'
});
const buildLabelStyle = (t) => ({
  marginBottom: '0.4rem', color: t.accent, fontWeight: 600,
  fontSize: '0.85rem', letterSpacing: '0.02em'
});
const buildBtn = (t) => (variant = 'primary', disabled = false) => ({
  padding: '0.7rem 1.1rem',
  background: disabled ? t.accentSoft
    : variant === 'primary' ? t.accent
    : variant === 'ghost'   ? t.ghostBg
    : variant === 'danger'  ? t.red
    : t.accentSoft,
  color: variant === 'primary'
    ? t.primaryText
    : variant === 'danger'
    ? '#ffffff'
    : t.text,
  border: variant === 'ghost' ? `1px solid ${t.ghostBorder}` : 'none',
  borderRadius: 8, cursor: disabled ? 'not-allowed' : 'pointer',
  fontSize: '0.9rem', fontWeight: 600, fontFamily: 'inherit',
  display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
  transition: 'all 0.15s ease'
});

let theme       = DARK_PALETTE;
let panelStyle  = buildPanelStyle(theme);
let inputStyle  = buildInputStyle(theme);
let labelStyle  = buildLabelStyle(theme);
let btn         = buildBtn(theme);

// applyThemeMode rewires the module-level style bindings + flips
// the body [data-theme] attribute (which drives the CSS-variable
// overrides in the head style block). Must be called BEFORE the
// App re-renders; the App does this in its toggle handler. Safe
// to call at module load too — we do, so the persisted
// preference is active before React paints the first frame.
const applyThemeMode = (mode) => {
  const t = (mode === 'light') ? LIGHT_PALETTE : DARK_PALETTE;
  theme       = t;
  panelStyle  = buildPanelStyle(t);
  inputStyle  = buildInputStyle(t);
  labelStyle  = buildLabelStyle(t);
  btn         = buildBtn(t);
  try {
    document.body.dataset.theme = t.name;
    localStorage.setItem('mrt-theme-mode', t.name);
  } catch {}
  return t.name;
};
// Apply the persisted preference before React mounts.
try {
  applyThemeMode('light');
} catch { applyThemeMode('light'); }

/* ==================== Parsers ==================== */
// A repeated card header — "### 💊 CARD 2 — Minoxidil", "--- ### CARD 3:",
// "CARD 2 —" — is a HARD boundary between cards. The model sometimes emits
// these delimiters between approved-treatment / candidate blocks; without
// treating them as a terminator, a card's last field (e.g. REFERENCES /
// SOURCES) swallows the next card's header + intro (the AGA "Finasteride
// sources bled Minoxidil's WHAT IT DOES" bug). Mirrors the hardened
// duplicate-field boundary added to parseCandidates.
const CARD_BOUNDARY_RE = /^(?:-{2,}\s*)?(?:#{1,6}\s*)?(?:💊\s*)?(?:(?:drug|treatment|combo|combination|candidate|supplement)\s+)?CARD\s+\d+\s*[—–:-]/i;
const isCardBoundaryLine = (line) => CARD_BOUNDARY_RE.test(String(line || '').trim());
const PARSER_LABEL_ALIASES = {
  'TREATMENT TYPE': 'PROVIDER',
  'FDA STATUS': 'FDA_STATUS',
  'DOSE AND SCHEDULE': 'LENGTH_FREQUENCY',
  'WHAT STUDIES FOUND': 'EFFICACY',
  'MEDICATION INTERACTIONS': 'INTERACTIONS',
  'SOURCES': 'REFERENCES',
  'DRUG OR SUPPLEMENT IDEA': 'CANDIDATE',
  'TYPE': 'ITEM_KIND',
  'USUALLY USED FOR': 'APPROVED_FOR',
  'WHAT IT DOES': 'WHAT_IT_DOES',
  'WHY IT MIGHT HELP': 'WHY_FOR_THIS_CONDITION',
  'WHY THIS OPTION WAS SEARCHED': 'WHY_FOR_THIS_CONDITION',
  'HOW IT MIGHT WORK': 'MECHANISM_TARGET',
  'REASON FOR CONSIDERING IT': 'REPURPOSE_RATIONALE',
  'RESEARCH CATEGORY': 'REPURPOSE_SECTION',
  'STRENGTH OF RESEARCH': 'EVIDENCE_STRENGTH',
  'WHAT THE RESEARCH SAYS': 'SUPPORTING_EVIDENCE',
  'THEORETICAL BENEFIT': 'EFFICACY_HYPOTHESIS',
  'SAFETY CONCERN': 'SAFETY',
  'RISKS FOR THIS PATIENT': 'PATIENT_SPECIFIC_RISKS',
  'QUESTIONS FOR YOUR DOCTOR': 'HOW_TO_DISCUSS_WITH_DOCTOR'
};
const canonicalParserKey = (line) => {
  const match = String(line || '').trim().match(/^([^:]{1,80}):/);
  if (!match) return '';
  const label = match[1].replace(/[*_]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
  return `${PARSER_LABEL_ALIASES[label] || label.replace(/\s+/g, '_')}:`;
};
const collectBlock = (text, startIdx, terminators) => {
  const lines = text.split('\n');
  let cur = lines[startIdx].split(':').slice(1).join(':').trim();
  let next = startIdx + 1;
  while (next < lines.length) {
    const trimmed = lines[next].trim();
    if (terminators.includes(canonicalParserKey(trimmed))) break;
    if (trimmed.startsWith('## ')) break;
    if (isCardBoundaryLine(trimmed)) break;
    if (trimmed) cur += ' ' + trimmed;
    next++;
  }
  return cur;
};

const TREATMENT_KEYS = [
  'PROVIDER:', 'TREATMENT:', 'FDA_STATUS:', 'LENGTH_FREQUENCY:',
  'EFFICACY:', 'SAFETY:', 'RISKS:', 'INTERACTIONS:', 'COST:', 'REFERENCES:'
];
const parseTreatments = (text) => {
  const blocks = [];
  const lines = text.split('\n');
  let cur = null;
  lines.forEach((line, i) => {
    const t = line.trim();
    const key = canonicalParserKey(t);
    if (!TREATMENT_KEYS.includes(key)) return;
    if (key === 'PROVIDER:') {
      if (cur) blocks.push(cur);
      cur = { _type: 'treatment' };
    } else if (key === 'TREATMENT:' && (!cur || cur.treatment)) {
      if (cur) blocks.push(cur);
      cur = { _type: 'treatment' };
    } else if (cur && cur.treatment && cur[key.replace(':', '').toLowerCase()] !== undefined) {
      // This field already has a value on the current, already-named card,
      // and no new TREATMENT:/PROVIDER: line was seen — the model dropped a
      // second card's own name line. Never let an orphaned field silently
      // overwrite the previous card's data (e.g. a Luxturna card ending up
      // with an unrelated drug's FDA status and safety citation); start a
      // new nameless block instead, which the treatment-name guard below
      // drops, same as any other unnamed card.
      blocks.push(cur);
      cur = { _type: 'treatment' };
    }
    if (!cur) return;
    const field = key.replace(':', '').toLowerCase();
    cur[field] = clampToCompleteSentence(collectBlock(text, i, TREATMENT_KEYS));
    // Post-parse: strip lone fabricated EFFICACY "NN%" scores without a
    // real endpoint / source link (leftover 45%/48%/50% meter residue).
    if (field === 'efficacy') {
      const v = String(cur.efficacy || '').replace(/\*/g, '').trim();
      const hasLink = /\[[^\]]+\]\(https?:\/\/[^)]+\)/i.test(v);
      const realEndpoint = /\b(mL\/?(?:year|yr)|FVC|FEV1|relapses?|episodes?|vs\.?\s*placebo|slowed\s+|reduced\s+by\s+\d)/i.test(v);
      const studyish = /\b(patients?|weeks?|months?|study|trial|placebo|cohort)\b/i.test(v);
      const lone = /^\s*\d{1,3}\s*%\s*$/.test(v);
      const shortFluff = (() => {
        const m = v.match(/^\s*\d{1,3}\s*%\s*[—–-]\s*(.+)$/i);
        if (!m) return false;
        const rest = m[1].trim();
        return rest.length > 0 && rest.length < 70 && !/\d/.test(rest) && !studyish;
      })();
      if (!hasLink && !realEndpoint && (lone || shortFluff)) {
        cur.efficacy = 'A source-supported measured outcome was not available in this search. Ask your clinician or review the linked guideline.';
      }
    }
    // EFFICACY is no longer a fabricated 0-100 rating — it is the real,
    // sourced outcome sentence (Dorothy: "those %s are made-up; show the
    // real study result"). It renders as prose, so we do NOT parse a
    // headline percent from it. SAFETY is still a relative % meter.
    if (field === 'safety') {
      // Safety is now a code-computed, evidence-backed Low/Moderate/High
      // band with FDA-sourced factor links (injected server-side). Prefer
      // the band; fall back to the legacy % meter for older cached reports.
      const band = parseBandRating(cur[field]);
      if (band) {
        cur.safety_band = band.band;
        cur.safety_note = band.note;
        cur.safety_pct = null;
      } else {
        cur.safety_pct = parseHeadlinePercent(cur[field]);
        cur.safety_note = splitMeterJustification(cur[field]);
      }
    }
  });
  if (cur) blocks.push(cur);
  // A manufacturer/provider is never a safe substitute for a missing
  // treatment identity. Drop malformed cards fail-closed; the verified KB
  // approved-treatment list can still show the actual treatment name.
  return blocks
    .filter((b) =>
      String(b.treatment || '').trim() &&
      /\[[^\]]+\]\(https?:\/\/[^)]+\)/i.test([
        b.references,
        b.efficacy,
        b.safety,
        b.risks,
        b.interactions
      ].filter(Boolean).join(' '))
    );
};

const REPURPOSE_KEYS = [
  'CANDIDATE:', 'ITEM_KIND:', 'CLASS:', 'APPROVED_FOR:', 'WHAT_IT_DOES:', 'WHY_FOR_THIS_CONDITION:',
  'MECHANISM_TARGET:', 'REPURPOSE_RATIONALE:', 'REPURPOSE_SECTION:', 'EVIDENCE_STRENGTH:',
  'SUPPORTING_EVIDENCE:', 'REFERENCES:', 'EFFICACY_HYPOTHESIS:', 'SAFETY:', 'CONFIDENCE:',
  'PATIENT_SPECIFIC_RISKS:', 'HOW_TO_DISCUSS_WITH_DOCTOR:'
];
// Helper: strip the leading "<N>% — " prefix from a meter value so
// we can show the % AND the prose justification separately. The
// prompt asks for "<1-100>% — <one-line justification>" so the
// separator is an em-dash or a hyphen. Returns whatever's left
// after the percentage + dash; falls back to the whole string.
const splitMeterJustification = (raw) => {
  if (!raw) return '';
  const m = String(raw).match(/^\s*\d{1,3}\s*%\s*[—\-–:]\s*(.+)$/);
  if (m) return m[1].trim();
  // Fallback: model returned "Vitamin A palmitate — visual cycle
  // substrate" without the percentage. Strip leading "%" if any.
  return String(raw).replace(/^\s*\d{1,3}\s*%\s*/, '').trim();
};

// Pillar 3 anti-contamination provenance (mirror of
// lib/report-polish.js assertNoForeignEntities). A candidate's
// self-describing fields (risks, safety, confidence, how-to-discuss) must
// describe THIS drug. A field whose subject is a DIFFERENT candidate's
// drug — and which does not name this card's own drug — cannot be traced
// to this card's provenance, so it is dropped rather than rendered under
// the wrong drug (the "Magnesium card shows Lumateperone's risks" bug).
const CANDIDATE_SELF_FIELDS = [
  'patient_specific_risks', 'safety', 'confidence',
  'efficacy_hypothesis', 'how_to_discuss_with_doctor',
  // "Usually used for: ... (SPIRONOLACTONE)" on a Candesartan card is another
  // drug's indication and source. CLASS / WHAT_IT_DOES are deliberately NOT
  // here: they legitimately name a comparator ("same family as axatilimab"),
  // and guarding them deleted those cards instead of cleaning them.
  'approved_for'
];
const candidateIdentityKey = (name) =>
  String(name || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]/g, '').trim();
const candidateSearchTerms = (name) => {
  const raw = String(name || '').replace(/\*/g, '');
  const terms = [];
  const lead = raw.replace(/\(.*?\)/g, ' ').split(/[—–]|\s-\s|:|\|/)[0].replace(/\s+\d.*$/, '').trim();
  if (lead.length >= 4) terms.push(lead);
  const paren = raw.match(/\(([^)]+)\)/);
  if (paren) {
    paren[1].split(/[,/]/).forEach((piece) => {
      const p = piece.trim();
      if (p.length >= 4 && !/^\d/.test(p)) terms.push(p);
    });
  }
  return terms;
};
const escapeRegExpClient = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const dropForeignCandidateFields = (cands) => {
  const ident = cands.map((c) => ({
    key: candidateIdentityKey(c.candidate),
    terms: candidateSearchTerms(c.candidate)
  }));
  cands.forEach((cand, ci) => {
    const self = ident[ci];
    if (!self.key) return;
    const foreign = ident.filter((x, i) =>
      i !== ci && x.key && !drugKeysMatch(x.key, self.key) && x.terms.length);
    if (!foreign.length) return;
    CANDIDATE_SELF_FIELDS.forEach((field) => {
      const val = cand[field];
      if (val == null) return;
      const lower = String(val).toLowerCase();
      const namesSelf = self.terms.some((t) => lower.includes(t.toLowerCase()));
      if (namesSelf) return;
      const hit = foreign.some((f) =>
        f.terms.some((t) => new RegExp('\\b' + escapeRegExpClient(t) + '\\b', 'i').test(String(val))));
      if (hit) {
        delete cand[field];
        delete cand[field + '_pct'];
        delete cand[field + '_band'];
        delete cand[field + '_note'];
      }
    });
  });
  return cands;
};

const parseCandidates = (text) => {
  const out = [];
  const lines = text.split('\n');
  let cur = null;
  lines.forEach((line, i) => {
    const t = line.trim();
    const key = canonicalParserKey(t);
    if (!REPURPOSE_KEYS.includes(key)) return;
    const field = key.replace(':', '').toLowerCase();
    // A repeated field inside an already-open block means the model
    // dropped a CANDIDATE: delimiter and the NEXT drug's fields are
    // bleeding into this card (root cause of the "Magnesium" card that
    // showed Lumateperone's risks/confidence/sources). Treat the
    // duplicate key as a fresh candidate boundary so one drug's data can
    // never overwrite another's. The orphaned fragment (no CANDIDATE
    // name) is dropped during de-dup below.
    if (key === 'CANDIDATE:' || (cur && cur[field] !== undefined)) {
      if (cur) out.push(cur);
      cur = {};
    }
    if (!cur) return;
    cur[field] = collectBlock(text, i, REPURPOSE_KEYS);
    // EFFICACY_HYPOTHESIS is now an honest, sourced statement of expected
    // benefit (or "no human efficacy data yet") — NOT a fabricated %. It
    // renders as prose, so we do not parse a headline percent from it.
    // SAFETY and CONFIDENCE remain relative % meters.
    if (field === 'safety') {
      // Evidence-backed band (server-injected) with % fallback for older
      // cached reports.
      const band = parseBandRating(cur[field]);
      if (band) {
        cur.safety_band = band.band;
        cur.safety_note = band.note;
        cur.safety_pct = null;
      } else {
        cur.safety_pct = parseHeadlinePercent(cur[field]);
        cur.safety_note = splitMeterJustification(cur[field]);
      }
    } else if (field === 'confidence') {
      // Confidence is a Low/Moderate/High band that MUST carry citable
      // evidence. With no clickable [source](url), the rating is pure
      // opinion — drop it entirely rather than render an unsourced meter.
      const band = parseBandRating(cur[field]);
      if (hasCitableLink(cur[field])) {
        if (band) {
          cur.confidence_band = band.band;
          cur.confidence_note = band.note;
        } else {
          cur.confidence_pct = parseHeadlinePercent(cur[field]);
          cur.confidence_note = splitMeterJustification(cur[field]);
        }
      }
    }
  });
  if (cur) out.push(cur);
  // Candidates now come from several parallel "lane" batches, so the
  // same drug can occasionally appear twice. De-duplicate by name,
  // keeping the higher-confidence copy.
  const confRank = (c) => c.confidence_band
    ? SAFETY_BAND_LEVEL[c.confidence_band.toLowerCase()] * 33
    : (c.confidence_pct || 0);
  const sorted = out.sort((a, b) => confRank(b) - confRank(a));
  const seenNames = new Set();
  const deduped = [];
  for (const cand of sorted) {
    // Drop orphan fragments produced when a merged block was split on a
    // duplicate field — a real candidate always carries a CANDIDATE name.
    if (!String(cand.candidate || '').trim()) continue;
    const norm = String(cand.candidate || '')
      .toLowerCase()
      .replace(/\(.*?\)/g, '')        // drop parenthetical brand/generic
      .replace(/[^a-z0-9]/g, '')      // ignore spacing/punctuation
      .trim();
    if (norm && seenNames.has(norm)) continue;
    if (norm) seenNames.add(norm);
    deduped.push(cand);
  }
  return dropForeignCandidateFields(deduped);
};

const isMechanisticEvidence = (value) => {
  const v = String(value || '').toUpperCase().trim();
  return v.includes('MECHANISTIC_ONLY');
};
// Dorothy product sections (Research tab layout):
//   neverResearched     — no study of this drug for this condition
//   researchedNotApproved — researched for the condition, not FDA-approved
const candidateCarriesCitation = (c) =>
  extractCitationUrls([
    c?.references, c?.supporting_evidence, c?.why_for_this_condition,
    c?.repurpose_rationale, c?.efficacy_hypothesis
  ].filter(Boolean).join(' '))
    .some((u) => !isGoogleSearchUrl(u) && !isDailyMedSearchUrl(u));

const partitionCandidates = (candidates, condition = '') => {
  const neverResearched = [];
  const researchedNotApproved = [];
  const evidenceStatusUnknown = [];
  // Legacy tier buckets kept for any lingering callers / strength chips.
  const human = [];
  const preclinical = [];
  const mechanistic = [];
  (candidates || []).forEach(c => {
    // Pipeline programmes belong to the treatments-in-development section, not
    // to a list of options to discuss. They also arrived with no citation, so
    // they were being dropped later anyway after consuming a slot.
    if (isPipelineProgramme(c?.candidate)) return;
    const section = resolveRepurposeSection(c, {
      condition,
      hasCitation: candidateCarriesCitation(c)
    });
    const enriched = { ...c, _repurpose_section: section, _item_kind: resolveItemKind(c) };
    if (section === 'researched-not-approved') researchedNotApproved.push(enriched);
    else if (section === 'no-condition-study-identified') neverResearched.push(enriched);
    else evidenceStatusUnknown.push(enriched);
    const v = String(c.evidence_strength || '').toUpperCase();
    if (v.includes('PRECLINICAL')) preclinical.push(enriched);
    else if (v.includes('MECHANISTIC_ONLY') || c._uncited) mechanistic.push(enriched);
    else human.push(enriched);
  });
  // The same agent must not appear in both sections: one card would say no
  // condition-specific study exists while the other links that very study.
  // TUDCA shipped in both. The researched entry wins, because it carries the
  // evidence.
  // Compare on the leading term. The full-name key treated "Lutein" and
  // "Lutein and zeaxanthin (macular carotenoids)" as different agents, so the
  // same supplement appeared in both sections — one card denying the study the
  // other links.
  const leadingTerm = (name) => String(name || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)[0] || '';
  const researchedKeys = new Set(researchedNotApproved.map((c) => leadingTerm(c.candidate)));
  const dedupedNever = neverResearched.filter((c) => {
    const key = leadingTerm(c.candidate);
    return !key || !researchedKeys.has(key);
  });
  neverResearched.length = 0;
  neverResearched.push(...dedupedNever);

  // Hard product cap: 10 ideas with condition-specific research and 10 without.
  // Extra candidates are dropped, never shown — the sections are a shortlist to
  // take to a clinician, not an exhaustive dump.
  const cap = (list) => list.slice(0, REPURPOSE_SECTION_DISPLAY_CAP);
  return {
    neverResearched: cap(neverResearched),
    researchedNotApproved: cap(researchedNotApproved),
    evidenceStatusUnknown: cap(evidenceStatusUnknown),
    human,
    preclinical,
    mechanistic
  };
};

// Combination cards. The combo back-call sometimes emits field labels
// WITHOUT underscores (e.g. "EVIDENCE TIER:", "SUPPORTING EVIDENCE:",
// "PATIENT SPECIFIC RISKS:") or with markdown bold, while the single-drug
// CANDIDATE cards use underscored labels. Match the field by NORMALIZING
// the leading label (strip spaces/underscores/markdown) so the parser is
// robust to both styles — otherwise a label mismatch makes RATIONALE
// swallow every later field and the card renders as one raw ALLCAPS blob.
const COMBO_FIELD_BY_NORM = {
  COMBO: 'combo',
  RATIONALE: 'rationale',
  EVIDENCETIER: 'evidence_tier',
  SUPPORTINGEVIDENCE: 'supporting_evidence',
  INTERACTIONRISK: 'interaction_risk',
  PATIENTSPECIFICRISKS: 'patient_specific_risks',
  CONFIDENCE: 'confidence',
  HOWTODISCUSSWITHDOCTOR: 'how_to_discuss_with_doctor',
  REFERENCES: 'references'
};
const comboFieldFromLine = (line) => {
  const t = String(line || '').trim().replace(/\*\*/g, '');
  const m = t.match(/^([A-Za-z][A-Za-z _\-]*?)\s*:/);
  if (!m) return null;
  const norm = m[1].replace(/[^a-z0-9]/gi, '').toUpperCase();
  return COMBO_FIELD_BY_NORM[norm] || null;
};
const collectComboValue = (lines, startIdx) => {
  let cur = lines[startIdx].split(':').slice(1).join(':').replace(/^\s*\*+\s*/, '').trim();
  let next = startIdx + 1;
  while (next < lines.length) {
    const trimmed = lines[next].trim();
    if (comboFieldFromLine(trimmed)) break;
    if (trimmed.startsWith('## ')) break;
    if (isCardBoundaryLine(trimmed)) break;
    if (trimmed) cur += ' ' + trimmed;
    next++;
  }
  return cur;
};
const COMBO_TRAILING_FIELDS = [
  'interaction_risk', 'patient_specific_risks', 'confidence',
  'how_to_discuss_with_doctor', 'references'
];
const parseCombos = (text) => {
  const out = [];
  const lines = text.split('\n');
  let cur = null;
  lines.forEach((line, i) => {
    const field = comboFieldFromLine(line);
    if (!field) return;
    // COMBO: opens a card. A repeated field inside an already-open card
    // means the model dropped a COMBO: delimiter — treat the duplicate as
    // a fresh boundary so one combo's fields can't overwrite another's
    // (mirror of the hardened parseCandidates boundary logic).
    if (field === 'combo' || (cur && cur[field] !== undefined)) {
      if (cur) out.push(cur);
      cur = {};
    }
    if (!cur) return;
    cur[field] = collectComboValue(lines, i);
    if (field === 'confidence') {
      // Band + citable-evidence requirement (mirror of parseCandidates).
      const band = parseBandRating(cur[field]);
      if (hasCitableLink(cur[field])) {
        if (band) {
          cur.confidence_band = band.band;
          cur.confidence_note = band.note;
        } else {
          const num = cur[field].match(/(\d{1,3})\s*%/);
          cur.confidence_pct = num ? parseInt(num[1]) : null;
          cur.confidence_note = splitMeterJustification(cur[field]);
        }
      }
    }
  });
  if (cur) out.push(cur);
  // Drop orphan fragments (no COMBO name) produced by a duplicate-field split.
  const cleaned = out.filter((c) => String(c.combo || '').trim());
  // A token-budget cutoff truncates the FINAL combo mid-field so it never
  // reaches its trailing fields — drop it rather than render a half card.
  if (cleaned.length) {
    const last = cleaned[cleaned.length - 1];
    if (!COMBO_TRAILING_FIELDS.some((f) => last[f] !== undefined)) cleaned.pop();
  }
  return cleaned.filter((combo) => {
    const evidence = `${combo.supporting_evidence || ''} ${combo.references || ''}`;
    const hasExactStudyLanguage = /\b(stud(?:y|ied)|trial|randomi[sz]ed|cohort)\b/i.test(evidence);
    const hasSource = hasCitableLink(evidence);
    const speculative = /\bmechanistic|hypothesis only|no (?:human )?combo data\b/i.test(evidence);
    return hasExactStudyLanguage && hasSource && !speculative;
  });
};

// Loud leak-detector invariant (client mirror of lib/report-polish.js
// detectStructuralLeak / auditCardFields). A parsed card field that still
// contains a card-boundary marker or a known field label (underscored OR
// not) followed by a colon did NOT parse — render a visible "formatting
// issue" indicator instead of the raw blob, and warn loudly. Only a
// STRUCTURAL token flags; prose that merely mentions a term does not.
const STRUCTURAL_FIELD_LABELS = new Set([
  'PROVIDER', 'TREATMENT', 'FDASTATUS', 'LENGTHFREQUENCY', 'EFFICACY', 'SAFETY',
  'RISKS', 'INTERACTIONS', 'COST', 'REFERENCES',
  'CANDIDATE', 'ITEMKIND', 'CLASS', 'APPROVEDFOR', 'WHATITDOES', 'WHYFORTHISCONDITION',
  'WHYITMIGHTHELP', 'MECHANISMTARGET', 'REPURPOSERATIONALE', 'REPURPOSESECTION',
  'EVIDENCESTRENGTH', 'SUPPORTINGEVIDENCE', 'EFFICACYHYPOTHESIS', 'CONFIDENCE',
  'PATIENTSPECIFICRISKS', 'HOWTODISCUSSWITHDOCTOR',
  'COMBO', 'RATIONALE', 'EVIDENCETIER', 'INTERACTIONRISK'
]);
const PUBLIC_LEAK_SKELETONS = [
  'evidencepack', ['k', '8'].join(''), 'diligencepacket', 'demorehearsal', 'challengesuite',
  'groundedevidence', 'dossiersourced', 'diseasedossier', 'faers', 'promptpack',
  'secondai', 'modelfallbackchain', 'internalpipeline', 'citationaudit',
  'validationstatus', 'schemavalidation', 'saveddemoprovenance', 'sourcesha',
  'serverseal', 'reportseal', 'profilekey', 'reviewedgitsha', 'coveragemessages',
  'repurposesection', 'evidencestrength', 'patientspecificrisks', 'internalerror',
  'upstreamstacktrace'
];
const publicLeakSkeleton = (value) => {
  const confusableAscii = {
    а: 'a', с: 'c', е: 'e', і: 'i', ј: 'j',
    о: 'o', р: 'p', ѕ: 's', х: 'x', у: 'y'
  };
  return [...String(value ?? '').normalize('NFKC').toLowerCase()
    .replace(/[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')]
    .map((char) => confusableAscii[char] || char)
    .join('')
    .replace(/[^\p{L}\p{N}]+/gu, '');
};
const CARD_BOUNDARY_LEAK_RE = /(?:#{1,6}\s*)?(?:💊\s*)?CARD\s+\d+\s*[—–:-]/i;
const LEAK_LABEL_RE = /(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9 _]{2,48}?)\s*:/g;
const detectStructuralLeak = (value) => {
  const s = String(value == null ? '' : value);
  if (!s) return [];
  const hits = [];
  const skeleton = publicLeakSkeleton(s);
  if (PUBLIC_LEAK_SKELETONS.some((term) =>
    skeleton.includes(term) || skeleton.includes(`${term}s`)
  )) hits.push('reader-language boundary');
  if (CARD_BOUNDARY_LEAK_RE.test(s)) hits.push('CARD boundary');
  LEAK_LABEL_RE.lastIndex = 0;
  let m;
  while ((m = LEAK_LABEL_RE.exec(s)) !== null) {
    const words = m[1].trim().split(/\s+/);
    for (let k = 0; k < words.length; k++) {
      const norm = words.slice(k).join('').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (STRUCTURAL_FIELD_LABELS.has(norm)) { hits.push(`${words.slice(k).join(' ')}:`); break; }
    }
  }
  return [...new Set(hits)];
};
// Returns { card, leaks }: a shallow clone whose leaked string fields are
// nulled (so the normal render skips them) plus the per-field leak list.
// Logs a clear warning with card/field/condition context — never silent.
const auditAndScrubCard = (card, fields, ctx) => {
  if (!card || typeof card !== 'object') return { card, leaks: [] };
  const out = { ...card };
  const leaks = [];
  for (const f of fields) {
    if (typeof out[f] !== 'string') continue;
    const tokens = detectStructuralLeak(out[f]);
    if (!tokens.length) continue;
    leaks.push({ field: f, tokens, value: out[f] });
    out[f] = null;
    if (out[f + '_note'] !== undefined) out[f + '_note'] = null;
  }
  if (leaks.length) {
    console.warn(
      `[leak-detector] ${ctx?.kind || 'card'} "${ctx?.label || '(unknown)'}"` +
      (ctx?.condition ? ` [${ctx.condition}]` : '') +
      ` has unparsed structural tokens: ` +
      leaks.map((l) => `${l.field} → {${l.tokens.join(', ')}}`).join(' | ')
    );
  }
  return { card: out, leaks };
};

const TRIAL_KEYS = [
  'TRIAL:', 'NCT:', 'URL:', 'PHASE:', 'STATUS:', 'ACCEPTING:', 'PLACEBO:',
  'TREATMENT_ONLY:', 'COUNTRY:', 'OVERSIGHT:', 'DESIGNATIONS:',
  'FIT_FOR_PATIENT:', 'HARM_RISK:', 'INTERACTIONS:', 'LOCATION_CONTACT:', 'SUMMARY:'
];
const parseTrialBlocks = (text) => {
  const out = [];
  const lines = text.split('\n');
  let cur = null;
  lines.forEach((line, i) => {
    const t = line.trim();
    const key = TRIAL_KEYS.find(k => t.startsWith(k));
    if (!key) return;
    if (key === 'TRIAL:') { if (cur) out.push(cur); cur = {}; }
    if (!cur) return;
    const field = key.replace(':', '').toLowerCase();
    cur[field] = collectBlock(text, i, TRIAL_KEYS);
    if (field === 'fit_for_patient' || field === 'harm_risk') {
      const num = cur[field].match(/(\d{1,3})\s*%/);
      cur[field + '_pct'] = num ? parseInt(num[1]) : null;
    }
  });
  if (cur) out.push(cur);
  return out;
};

// Auto-link bare NCT IDs only (registry records). Never invent PubMed/DOI
// links from bare PMIDs — those must come from the evidence allowlist.
const linkifyMedicalIds = (text) => {
  if (!text) return '';
  let s = String(text);
  const placeholders = [];
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (m) => {
    const key = `__MDLINK_${placeholders.length}__`;
    placeholders.push(m);
    return key;
  });
  s = s.replace(/\b(NCT\d{8})\b/gi, (m) => {
    const id = m.toUpperCase();
    return `[${id}](https://clinicaltrials.gov/study/${id})`;
  });
  s = s.replace(/(?<![(\[])(https?:\/\/[^\s)\]"']+)/g, (url) => {
    const clean = url.replace(/[.,;)]+$/, '');
    if (/google\.[a-z.]+\/search|dailymed\.nlm\.nih\.gov\/dailymed\/search\.cfm|pubmed\.ncbi\.nlm\.nih\.gov\/\?term=|clinicaltrials\.gov\/search/i.test(clean)) {
      return clean.replace(/^https?:\/\//, '').slice(0, 60);
    }
    const label = clean.replace(/^https?:\/\//, '').slice(0, 60);
    return `[${label}${clean.length > 60 ? '…' : ''}](${clean})`;
  });
  placeholders.forEach((m, i) => { s = s.replace(`__MDLINK_${i}__`, m); });
  return s;
};

// URLs the AI is allowed to cite — built from live trials pull + evidence pack.
const buildAllowedUrlSet = (trialsData, evidenceOrPack) => {
  const urls = new Set();
  const add = (u) => {
    if (!u || typeof u !== 'string') return;
    const canonical = canonicalReportUrl(u);
    if (canonical) urls.add(canonical);
  };
  const addArticle = (a) => {
    if (!a) return;
    [a.url, a.pmcUrl, a.pubmedUrl, a.doiUrl, a.oaUrl, a.landingUrl, a.europePmcUrl].forEach(add);
    if (a.pmid) {
      const id = String(a.pmid).replace(/\D/g, '');
      add(`https://pubmed.ncbi.nlm.nih.gov/${id}`);
      add(`https://pubmed.ncbi.nlm.nih.gov/${id}/`);
    }
    if (a.doi) {
      const d = String(a.doi).replace(/^https?:\/\/doi\.org\//i, '');
      add(`https://doi.org/${d}`);
    }
    if (a.nct || a.nctId) {
      add(`https://clinicaltrials.gov/study/${String(a.nct || a.nctId).toUpperCase()}`);
    }
  };
  (Array.isArray(trialsData?.studies) ? trialsData.studies : []).forEach((s) => {
    const exact = exactClinicalTrialUrl(s);
    if (exact) add(exact);
  });
  const lists = [];
  if (Array.isArray(evidenceOrPack)) {
    lists.push(evidenceOrPack);
  } else if (evidenceOrPack) {
    lists.push(
      evidenceOrPack.groundedForPrompt,
      evidenceOrPack.topRanked,
      evidenceOrPack.evidencePack
    );
    for (const d of evidenceOrPack.pipelineDrugs || []) {
      if (d.pmid) addArticle({ pmid: d.pmid });
      if (d.nct) add(`https://clinicaltrials.gov/study/${String(d.nct).toUpperCase()}`);
      add(d.url);
    }
    // FDA/DailyMed label citations (e.g. "REFERENCES: [FDA label](...)")
    // were never added to the allowlist, so a real, server-verified label
    // link would fail allowedReportUrl and render as inert "(FDA label)"
    // text instead of a clickable anchor.
    for (const f of evidenceOrPack.fdaLabels || []) {
      add(f?.dailyMedUrl || f?.url);
    }
    // Repurpose drug pool and screen — URLs from drug registry evidence.
    for (const d of evidenceOrPack.repurposeDrugPool || []) {
      if (d.pmid) addArticle({ pmid: d.pmid });
      add(d.dailyMedUrl);
      add(d.url);
    }
    for (const d of evidenceOrPack.repurposeDrugScreen?.fillPool || []) {
      add(d.dailyMedUrl);
    }
  }
  for (const list of lists) {
    for (const a of list || []) addArticle(a);
  }
  return urls;
};

const urlIsAllowed = (href, allowedUrls) => {
  return !!allowedReportUrl(href, allowedUrls);
};

function exactClinicalTrialUrl(study = {}) {
  const nctId = String(study.nctId || study.nct || '').trim().toUpperCase();
  if (!/^NCT\d{8}$/.test(nctId)) return null;
  const expected = canonicalReportUrl(`https://clinicaltrials.gov/study/${nctId}`);
  const supplied = study.url ? canonicalReportUrl(String(study.url).trim()) : expected;
  return expected && supplied === expected ? expected : null;
}

// A DailyMed SEARCH results page is NEVER a citation (client mandate) —
// only a specific label monograph (drugInfo.cfm?setid=…) is. Strip any
// DailyMed search link to plain text (keep the anchor label), matching
// lib/report-polish.js stripDailyMedSearchLinks so client render + exports
// never surface one even if it slips past the server.
const stripDailyMedSearchLinks = (text) => {
  if (!text) return text;
  let s = String(text);
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/(?:www\.)?dailymed\.nlm\.nih\.gov\/dailymed\/search\.cfm[^)]*)\)/gi,
    '$1'
  );
  s = s.replace(
    /(?<![(\[])https?:\/\/(?:www\.)?dailymed\.nlm\.nih\.gov\/dailymed\/search\.cfm[^\s)\]"'<>]*/gi,
    ''
  );
  return s;
};
// Display label for an anchor: strip markdown emphasis markers and, for a
// bare "Google search" anchor, relabel to a clean "Search ↗" so the words
// "Google search" never render as a user-facing link label.
const cleanAnchorLabel = (label, url) => {
  const stripped = String(label == null ? '' : label)
    .replace(/\*\*|__|\*|_/g, '')
    .replace(/[[\]()↗]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (isGoogleSearchUrl(url) && (!stripped || /^google\s*search$/i.test(stripped))) {
    return 'Search ↗';
  }
  return stripped;
};

// Strip markdown links the model invented (not in trials/evidence pack).
// When a link is not allowed we keep the human-readable label/citation
// text and SILENTLY drop the dead link — never surface an internal
// "removed link" scaffolding note to users.
const sanitizeMarkdownLinks = (text, allowedUrls) => {
  if (!text) return text;
  let base = stripDailyMedSearchLinks(text);
  // Strip Google / PubMed-search / CT-search placeholders unconditionally.
  base = String(base)
    .replace(
      /\[([^\]]+)\]\((https?:\/\/(?:www\.)?google\.[a-z.]+\/search[^)]*)\)/gi,
      (_match, label, url) => cleanAnchorLabel(label, url)
    )
    .replace(/\[([^\]]+)\]\(https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/\?term=[^)]*\)/gi, '$1')
    .replace(/\[([^\]]+)\]\(https?:\/\/(?:www\.)?clinicaltrials\.gov\/search[^)]*\)/gi, '$1');
  // FAIL-CLOSED: no allowlist → strip every remaining deep http(s) markdown link
  // to plain label (keep NCT study / FDA DAF / DailyMed setid via urlIsAllowed).
  let s = String(base);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (m, label, url) =>
    urlIsAllowed(url, allowedUrls) ? m : label);
  s = s.replace(/(?<![(\[])(https?:\/\/[^\s)\]"']+)/g, (url) => {
    const clean = url.replace(/[.,;)]+$/, '');
    return urlIsAllowed(clean, allowedUrls)
      ? `[${clean.replace(/^https?:\/\//, '').slice(0, 50)}](${clean})`
      : clean.replace(/^https?:\/\//, '');
  });
  return s;
};

// FUNDAMENTAL (client mandate): embed an inline ([source ↗](url)) after
// every significant claim that still lacks a link — using the evidence
// pack / trials URLs only. Never invents URLs. Runs at DISPLAY time so
// links sit next to the claim in the report body (not a bottom bibliography).
// Drop sentences that name a different disease than the patient's condition
// (Dorothy failure mode: sickle cell prose on an IPF/RP report).
const FOREIGN_DISEASE_MARKERS = [
  { id: 'sickle-cell', self: /\bsickle\b/i, phrases: [/\bsickle\s*cell\b/i, /\bHbSS\b/, /\bvaso-?occlusive (?:pain )?crisis\b/i, /\bcrizanlizumab\b/i, /\bvoxelotor\b/i, /\bCasgevy\b/i, /\bexa-?cel\b/i, /\bLyfgenia\b/i, /\bOxbryta\b/i, /\bAdakveo\b/i] },
  { id: 'alzheimer', self: /\balzheimer/i, phrases: [/\balzheimer['']?s?\b/i] },
  { id: 'parkinson', self: /\bparkinson/i, phrases: [/\bparkinson['']?s?\b/i] },
  { id: 'huntington', self: /\bhuntington/i, phrases: [/\bhuntington['']?s?\b/i] },
  { id: 'duchenne', self: /\bduchenne|\bDMD\b/, phrases: [/\bduchenne\b/i] },
  { id: 'retinitis', self: /\bretinitis|\bRP\b|pigmentosa/i, phrases: [/\bretinitis\s+pigmentosa\b/i] },
  { id: 'ipf', self: /\bpulmonary\s+fibrosis|\bIPF\b|\bfibrosing\s+alveolitis\b/i, phrases: [/\bidiopathic\s+pulmonary\s+fibrosis\b/i] },
  { id: 'schizophrenia', self: /\bschizophren/i, phrases: [/\bschizophrenia\b/i] },
  { id: 'bipolar', self: /\bbipolar\b/i, phrases: [/\bbipolar\s+disorder\b/i] },
  { id: 'lada', self: /\bLADA\b|latent\s+autoimmune/i, phrases: [/\blatent\s+autoimmune\s+diabetes\b/i, /\bLADA\b/] },
  { id: 't1d', self: /\btype\s*1\s+diabetes|\bT1D\b/i, phrases: [/\btype\s*1\s+diabetes\b/i] },
  { id: 't2d', self: /\btype\s*2\s+diabetes|\bT2D\b/i, phrases: [/\btype\s*2\s+diabetes\b/i] },
  { id: 'als', self: /\bALS\b|amyotrophic/i, phrases: [/\bamyotrophic\s+lateral\s+sclerosis\b/i] },
  { id: 'lca', self: /\bleber\s+congenital|\bLCA\b/i, phrases: [/\bleber\s+congenital\s+amaurosis\b/i] }
];
const blobMentionsForeignDisease = (blob, patientCondition = '') => {
  const cond = String(patientCondition || '').trim();
  if (!cond) return false;
  const active = FOREIGN_DISEASE_MARKERS.filter((m) => !m.self.test(cond));
  const text = String(blob || '');
  return active.some((m) => m.phrases.some((re) => re.test(text)));
};
const stripForeignDiseaseContamination = (text, patientCondition = '') => {
  if (!text) return text;
  const cond = String(patientCondition || '').trim();
  if (!cond) return text;
  const active = FOREIGN_DISEASE_MARKERS.filter((m) => !m.self.test(cond));
  if (!active.length) return text;
  return String(text).split('\n').map((line) => {
    if (line.includes('|') && line.split('|').length >= 3) return line;
    if (active.some((m) => m.phrases.some((re) => re.test(line))) && /^\s{0,3}#{1,6}\s/.test(line)) return '';
    const parts = line.split(/(?<=[.!?])\s+/);
    const kept = parts.filter((part) => !active.some((m) => m.phrases.some((re) => re.test(part))));
    if (!kept.length) return '';
    const lead = line.match(/^(\s*[-*•]\s+)/);
    const body = kept.join(' ').trim();
    if (!body) return '';
    if (lead && !/^\s*[-*•]\s/.test(body)) return `${lead[1]}${body}`;
    return (line.match(/^\s*/)?.[0] || '') + body;
  }).join('\n').replace(/\n{3,}/g, '\n\n');
};

const embedInlineClaimCitations = (text, evidenceOrPack, trialsData, patientCondition = '') => {
  if (!text) return text;
  const items = [];
  const seen = new Set();
  const push = (it) => {
    if (!it) return;
    let url = String(it.url || it.pmcUrl || it.pubmedUrl || it.doiUrl || it.oaUrl || '').trim();
    if (!url && it.pmid) url = `https://pubmed.ncbi.nlm.nih.gov/${String(it.pmid).replace(/\D/g, '')}/`;
    if (!url && it.doi) url = `https://doi.org/${String(it.doi).replace(/^https?:\/\/doi\.org\//i, '')}`;
    if (!url && (it.nct || it.nctId)) {
      url = `https://clinicaltrials.gov/study/${String(it.nct || it.nctId).toUpperCase()}`;
    }
    if (!/^https?:\/\//i.test(url)) return;
    if (/dailymed\.nlm\.nih\.gov\/dailymed\/search\.cfm/i.test(url)) return;
    const key = url.toLowerCase().replace(/\/$/, '');
    if (seen.has(key)) return;
    seen.add(key);
    items.push({
      url,
      blob: `${it.title || ''} ${it.text || it.summary || it.abstract || ''} ${it.name || ''}`.toLowerCase()
    });
  };
  const ev = evidenceOrPack;
  if (Array.isArray(ev)) ev.forEach(push);
  else if (ev) {
    (ev.groundedForPrompt || []).forEach(push);
    (ev.topRanked || []).forEach(push);
    (ev.evidencePack || []).forEach(push);
    (ev.pipelineDrugs || []).forEach(push);
  }
  (trialsData?.studies || []).forEach((s) => push({
    title: s.title, name: s.nctId, nctId: s.nctId, url: s.url
  }));
  if (!items.length) return text;

  const STOP = new Set([
    'that', 'this', 'with', 'from', 'have', 'been', 'were', 'their', 'about', 'into',
    'also', 'only', 'than', 'then', 'when', 'which', 'while', 'after', 'before',
    'under', 'over', 'your', 'you', 'will', 'would', 'could', 'should', 'must',
    'and', 'the', 'for', 'are', 'was', 'not', 'but', 'can', 'may', 'its', 'any',
    'all', 'has', 'had', 'research', 'suggests', 'studies', 'report', 'literature',
    'evidence', 'guidelines', 'patient', 'patients', 'doctor', 'physician', 'condition',
    'disease', 'disorder', 'syndrome', 'cell', 'cells'
  ]);
  const tokens = (s) => String(s || '').toLowerCase().replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP.has(w));
  const cond = String(patientCondition || '').trim();
  const condToks = tokens(cond);
  const activeForeign = cond
    ? FOREIGN_DISEASE_MARKERS.filter((m) => !m.self.test(cond))
    : [];
  // Never attach a pack item whose source text is about a different disease.
  const eligible = items.filter((it) => {
    if (activeForeign.some((m) => m.phrases.some((re) => re.test(it.blob)))) return false;
    // Document URLs must mention the patient's condition when we can tell.
    if (condToks.length && /pubmed|doi\.org|pmc\.ncbi|nature\.com|sciencedirect|nejm\.org|thelancet|jama|cell\.com|springer|wiley/i.test(it.url)) {
      if (!condToks.some((t) => it.blob.includes(t))) return false;
    }
    return true;
  });
  if (!eligible.length) return text;

  const MUST = /\b(research suggests|studies (?:report|show|found|estimate)|literature (?:reports|cautions|notes|warns|supports)|evidence suggests|guidelines?\b|physicians? (?:generally |often )?(?:caution|advise|recommend)|prevalence|incidence|typical path|without treatment|primary specialty|falls? risk|neurodegenerat|dopamine|tremor|stiffness|impulse control|sparx|lsvt|mds\b|is a |disorder|nerve cells|brain disorder)\b/i;
  const hasLink = (s) => /\[[^\]]+\]\(https?:\/\/[^)]+\)|(?<![(\[])https?:\/\/\S+/i.test(s);
  const score = (toks, item) => {
    if (!toks.length || !item.blob) return 0;
    let hits = 0;
    for (const t of toks) if (item.blob.includes(t)) hits += t.length >= 6 ? 1.4 : 1;
    return hits / toks.length;
  };
  const overview = eligible.find((it) =>
    /guideline|review|evidence-based|overview|epidemiolog|pathophysiol/.test(it.blob) &&
    (!condToks.length || condToks.some((t) => it.blob.includes(t)))
  ) || eligible[0];

  return String(text).split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed || /^#{1,6}\s/.test(trimmed) || /^CANDIDATE:/i.test(trimmed)) return line;
    // Never inject source cites into GFM tables (Pipeline Watch).
    if (trimmed.includes('|') && trimmed.split('|').length >= 3) return line;
    if (hasLink(line)) return line;
    // Whole bullet / sentence as one claim unit
    const claim = trimmed.replace(/^[-*•]\s+/, '').replace(/^\*\*[^*]+\*\*[:\s]*/, '');
    if (claim.length < 28 || !MUST.test(claim)) return line;
    // Negative / empty findings do not need a citation.
    if (/\bnone\s+(?:identified|found)\b/i.test(claim) || /\bnot\s+identified\b/i.test(claim) || /\bno\s+published\s+source\b/i.test(claim) || /\bevidence[- ]pack\b/i.test(claim)) return line;
    const toks = tokens(claim);
    if (toks.length < 2) return line;
    let best = null;
    let bestScore = 0;
    for (const it of eligible) {
      const sc = score(toks, it);
      if (sc > bestScore) { bestScore = sc; best = it; }
    }
    let url = null;
    if (best && bestScore >= 0.10) url = best.url;
    else if (/\b(is a |disorder|nerve cells|brain disorder|prevalence|typical path)\b/i.test(claim) && overview) {
      url = overview.url;
    } else if (best && bestScore >= 0.14) url = best.url;
    if (!url || !/^https?:\/\//i.test(url)) return line;
    if (/web\.sph\.uth\.edu\/RetNet/i.test(url) || /sph\.uth\.edu\/RetNet/i.test(url)) return line;
    const cite = ` ([source ↗](${url}))`;
    if (/[.!?]["']?\s*$/.test(trimmed)) {
      return line.replace(/([.!?]["']?)(\s*)$/, `${cite}$1$2`);
    }
    return `${line.replace(/\s+$/, '')}${cite}`;
  }).join('\n');
};

// Strip internal pipeline jargon before showing or exporting a report.
const polishReportForDisplay = (text, { keepHedges = false } = {}) => {
  if (!text) return text;
  let s = String(text);
  s = s.replace(/~~([^~]+)~~/g, '$1');
  if (keepHedges) {
    s = s.replace(/\bNo grounded evidence in pack\b/gi, 'Limited published sources were found for this claim');
    s = s.replace(/\bno grounded prevalence number in pack\b/gi, 'no published prevalence figure was found');
    s = s.replace(/\bdossier[- ]sourced\b/gi, '');
  } else {
    s = s.replace(/^[^\n]*\bNo grounded evidence[^\n]*$/gim, '');
    s = s.replace(/^[^\n]*\bno grounded prevalence[^\n]*$/gim, '');
    s = s.replace(/^[^\n]*\bno grounded prevalence number in pack[^\n]*$/gim, '');
    s = s.replace(/\bNo grounded evidence in pack\b/gi, '');
    s = s.replace(/\bno grounded prevalence number in pack\b/gi, '');
    s = s.replace(/\bdossier[- ]sourced\b/gi, '');
    s = s.replace(/\bdossier source\b/gi, '');
    s = s.replace(/\s*\(dossier-sourced[^)]*\)/gi, '');
  }
  s = s.replace(/\bconfirmed against grounded evidence\b/gi, '');
  s = s.replace(/\bGROUNDED EVIDENCE PACK\b/gi, '');
  s = s.replace(/\bgrounded evidence pack\b/gi, '');
  s = s.replace(/\bDisease-dossier uncertainty[^.\n]*/gi, '');
  s = s.replace(/\buncertainty score[^.\n]*/gi, '');
  s = s.replace(/\s*\(confirmed against grounded evidence[^)]*\)/gi, '');
  s = s.replace(/\s*\[(FULL-TEXT|ABSTRACT-ONLY|METADATA-ONLY|CURATED KB|PREPRINT[^\]]*)\]\s*/gi, ' ');
  // Plain-English rewrites (mirror lib/report-polish.js rewritePatientJargon).
  s = s.replace(/\bthe evidence[- ]pack does not (?:provide|include|contain|list)\s+FAERS\b[^.|]*/gi, 'FDA post-market report counts were not available in the sources we reviewed');
  s = s.replace(/\bthe evidence[- ]pack does not (?:provide|include|contain|list)\b/gi, 'we did not find');
  s = s.replace(/\b(?:in|from|among|within)\s+(?:this|the)\s+evidence[- ]pack\b/gi, 'in the sources we reviewed');
  s = s.replace(/\b[Nn]o evidence[- ]pack items?\b/g, 'No published source found here');
  s = s.replace(/\bevidence[- ]pack items?\b/gi, 'published sources');
  s = s.replace(/\bthe evidence[- ]pack\b/gi, 'the sources we reviewed');
  s = s.replace(/\bthis evidence[- ]pack\b/gi, 'the sources we reviewed');
  s = s.replace(/\ban? evidence[- ]pack\b/gi, 'the sources we reviewed');
  s = s.replace(/\bevidence[- ]pack\b/gi, 'sources');
  s = s.replace(/\bevidence[\s-]*packs?\b/gi, 'source collections');
  s = s.replace(/\bK[\s-]*8\b/gi, 'quality review');
  s = s.replace(/\bdiligence[\s-]*packets?\b/gi, 'review materials');
  s = s.replace(/\bdemo[\s-]*rehearsals?\b/gi, 'presentation checks');
  s = s.replace(/\bchallenge[\s-]*suites?\b/gi, 'safety checks');
  s = s.replace(/\bNo grounded evidence\b/gi, 'No published source found');
  s = s.replace(/\bno grounded prevalence(?: number)?(?: in pack)?\b/gi, 'no published prevalence figure');
  s = s.replace(/\bgrounded evidence\b/gi, 'published research');
  s = s.replace(/\bDisease-dossier\b/gi, 'Condition');
  s = s.replace(/\bFAERS\b/g, 'FDA post-market reports');
  s = s.replace(/\bin this sources\b/gi, 'in the sources we reviewed');
  s = s.replace(/\bthe sources gathered here\b/gi, 'the sources we reviewed');
  s = s.replace(/\bPipeline Watch\b/gi, 'Treatments in development');
  s = s.replace(/\bpipeline drugs?\b/gi, 'treatments in development');
  s = s.replace(/\bdrug repurposing\b/gi, 'drug and supplement ideas');
  s = s.replace(/\brepurposing\b/gi, 'drug and supplement ideas');
  s = s.replace(/There is no research on this specific drug for ([^.\n]+)\./gi, 'No condition-specific study identified in this search for $1.');
  s = s.replace(/\bnever (?:been )?researched for\b/gi, 'had no condition-specific study identified in this search for');
  s = s.replace(/However,\s+our research suggests it may help,\s+and here is why\./gi, 'The indirect rationale comes from biological research in another context and does not imply benefit.');
  s = s.replace(/\bresearch (?:on [^.\n]+ )?shows promise\b/gi, 'research was identified');
  s = s.replace(/^INTERACTIONS:\s*None identified\.?\s*$/gim, 'INTERACTIONS: No interaction was identified in the reviewed information. A pharmacist or clinician should check the complete medication and supplement list.');
  s = s.replace(/\bACTIVE_NOT_RECRUITING\b/g, 'Active, not recruiting');
  s = s.replace(/\bNOT_YET_RECRUITING\b/g, 'Not yet recruiting');
  s = s.replace(/\bENROLLING_BY_INVITATION\b/g, 'Enrolling by invitation');
  s = s.replace(/\bNO_LONGER_AVAILABLE\b/g, 'No longer available');
  s = s.replace(/\bPHASE([1-4])\b/g, 'Phase $1');
  const visibleFieldLabels = {
    PROVIDER: 'Treatment type',
    TREATMENT: 'Treatment',
    FDA_STATUS: 'FDA status',
    LENGTH_FREQUENCY: 'Dose and schedule',
    EFFICACY: 'What studies found',
    SAFETY: 'Safety',
    RISKS: 'Risks',
    INTERACTIONS: 'Medication interactions',
    COST: 'Cost and coverage',
    REFERENCES: 'Sources',
    CANDIDATE: 'Drug or supplement idea',
    ITEM_KIND: 'Type',
    APPROVED_FOR: 'Usually used for',
    WHAT_IT_DOES: 'What it does',
    WHY_FOR_THIS_CONDITION: 'Why this option was searched',
    MECHANISM_TARGET: 'How it might work',
    REPURPOSE_RATIONALE: 'Reason for considering it',
    EVIDENCE_STRENGTH: 'Strength of research',
    SUPPORTING_EVIDENCE: 'What the research says',
    EFFICACY_HYPOTHESIS: 'Theoretical benefit',
    CONFIDENCE: 'Confidence',
    PATIENT_SPECIFIC_RISKS: 'Risks for this patient',
    HOW_TO_DISCUSS_WITH_DOCTOR: 'Questions for your doctor'
    ,
    COMBO: 'Combination studied',
    RATIONALE: 'Why it was studied together',
    EVIDENCE_TIER: 'Study evidence level',
    INTERACTION_RISK: 'Interaction concern',
    LOCATION_CONTACT: 'Study contact'
  };
  for (const [rawLabel, friendlyLabel] of Object.entries(visibleFieldLabels)) {
    s = s.replace(new RegExp(`^${rawLabel}:`, 'gim'), `${friendlyLabel}:`);
  }
  s = s.replace(/^(?:REPURPOSE_SECTION|CLASS):[^\n]*$/gim, '');
  // Strip empty / bare-hash / dead-RetNet / broken empty-applno FDA source anchors.
  s = s.replace(/\s*\(\s*\[[^\]]*source[^\]]*\]\(\s*\)\s*\)/gi, '');
  s = s.replace(/\s*\(\s*\[[^\]]*source[^\]]*\]\(#\)\s*\)/gi, '');
  s = s.replace(/\[[^\]]*source[^\]]*\]\(\s*\)/gi, '');
  s = s.replace(/\[[^\]]*source[^\]]*\]\(#\)/gi, '');
  s = s.replace(/\[([^\]]+)\]\(https?:\/\/(?:www\.)?web\.sph\.uth\.edu\/RetNet[^)]*\)/gi, '$1');
  s = s.replace(/\[([^\]]+)\]\(https?:\/\/(?:www\.)?sph\.uth\.edu\/RetNet[^)]*\)/gi, '$1');
  s = s.replace(/\[([^\]]+)\]\(https?:\/\/[^)]*accessdata\.fda\.gov\/scripts\/cder\/daf\/[^)]*applno=(?:&|[^0-9])[^)]*\)/gi, '$1');
  s = s.replace(/\[([^\]]+)\]\(https?:\/\/(?:www\.)?google\.[^)]*\/search[^)]*\)/gi, '$1');
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  const confusableAscii = {
    а: 'a', с: 'c', е: 'e', і: 'i', ј: 'j',
    о: 'o', р: 'p', ѕ: 's', х: 'x', у: 'y'
  };
  const skeleton = [...String(s).normalize('NFKC').toLowerCase()
    .replace(/[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')]
    .map((char) => confusableAscii[char] || char)
    .join('')
    .replace(/[^\p{L}\p{N}]+/gu, '');
  const prohibited = [
    'evidencepack', ['k', '8'].join(''), 'diligencepacket', 'demorehearsal', 'challengesuite',
    'groundedevidence', 'dossiersourced', 'diseasedossier', 'faers', 'promptpack',
    'secondai', 'modelfallbackchain', 'internalpipeline', 'citationaudit',
    'validationstatus', 'schemavalidation', 'saveddemoprovenance', 'sourcesha',
    'serverseal', 'reportseal', 'profilekey', 'reviewedgitsha', 'coveragemessages',
    'repurposesection', 'evidencestrength', 'patientspecificrisks', 'internalerror',
    'upstreamstacktrace'
  ];
  if (prohibited.some((term) => skeleton.includes(term) || skeleton.includes(`${term}s`))) {
    throw new Error('Reader text did not pass the language boundary.');
  }
  return s;
};

// Keep a "## 3. Approved Treatments" placeholder so report numbering stays
// continuous (1, 2, 3, 4…) even though the prose is rendered as cards.
const SECTION_3_PLACEHOLDER =
  '## 3. Approved Treatments\n\nSee the treatment cards above for the approved options identified in this search, with dosing, evidence, and patient-specific interaction notes.';
const stripApprovedTreatmentsSection = (text) => {
  if (!text) return text;
  const s = String(text);
  const start = s.search(/^##\s*3\.\s*Approved Treatments/im);
  if (start < 0) return s;
  const rest = s.slice(start);
  const end = rest.search(/^##\s*4\./im);
  const placeholder = `${SECTION_3_PLACEHOLDER}\n\n`;
  if (end < 0) return (s.slice(0, start) + placeholder).replace(/\n{3,}/g, '\n\n').trim();
  return (s.slice(0, start) + placeholder + s.slice(start + end)).replace(/\n{3,}/g, '\n\n').trim();
};

// Mirror of lib/report-polish.js parseHeadlinePercent — strip markdown
// bold, prefer the headline percent at the start of the field.
const parseHeadlinePercent = (text) => {
  if (text == null) return null;
  const cleaned = String(text).replace(/\*/g, '');
  let m = cleaned.match(/^\s*(\d{1,3})\s*%/);
  if (!m) m = cleaned.match(/(\d{1,3})\s*%/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 0 && n <= 100 ? n : null;
};

// Mirror of lib/report-polish.js clampToCompleteSentence — drop a trailing
// mid-word fragment from a card field when a complete sentence precedes it.
const clampToCompleteSentence = (text) => {
  const s = String(text == null ? '' : text).trim();
  if (!s) return s;
  if (/[.!?)\]%"]$/.test(s)) return s;
  const m = s.match(/^([\s\S]*[.!?])(?=\s)([\s\S]*)$/);
  if (!m) return s;
  const head = m[1].trim();
  const tail = m[2].trim();
  if (!tail || head.length < 20) return s;
  const danglingDash = /[—–-]\s*\S{0,5}$/.test(tail);
  const shortFragment = tail.length <= 15;
  return (danglingDash || shortFragment) ? head : s;
};

const extractLinksFromText = (text) => {
  if (!text) return [];
  const links = [];
  const seen = new Set();
  const add = (url, label) => {
    const u = String(url || '').trim();
    if (!u || seen.has(u)) return;
    seen.add(u);
    links.push({ url: u, label: label || u });
  };
  const mdRe = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let m;
  while ((m = mdRe.exec(text)) !== null) { if (!isDailyMedSearchUrl(m[2])) add(m[2], m[1]); }
  const urlRe = /(https?:\/\/[^\s)\]"']+)/g;
  while ((m = urlRe.exec(text)) !== null) { const u = m[1].replace(/[.,;)]+$/, ''); if (!isDailyMedSearchUrl(u)) add(u); }
  const nctRe = /\b(NCT\d{8})\b/gi;
  while ((m = nctRe.exec(text)) !== null) {
    const id = m[1].toUpperCase();
    add(`https://clinicaltrials.gov/study/${id}`, id);
  }
  const pmidRe = /\bPMID[:\s#]*(\d{7,8})\b/gi;
  while ((m = pmidRe.exec(text)) !== null) {
    add(`https://pubmed.ncbi.nlm.nih.gov/${m[1]}/`, `PMID ${m[1]}`);
  }
  const doiRe = /\b(?:doi[:\s]*)(10\.\d{4,9}\/[^\s)\]"']+)/gi;
  while ((m = doiRe.exec(text)) !== null) {
    add(`https://doi.org/${m[1]}`, `DOI ${m[1]}`);
  }
  return links;
};

const parseReferences = (text) => {
  const refs = [];
  const seen = new Set();
  const add = (url, quote = '') => {
    const u = String(url || '').trim();
    if (!u || seen.has(u)) return;
    seen.add(u);
    refs.push({ url: u, quote });
  };
  if (!text) return refs;
  const mdRe = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let m;
  while ((m = mdRe.exec(text)) !== null) add(m[2], m[1]);
  const urlRe = /(https?:\/\/[^\s)]+)(?:\s*[-—:]\s*["“]([^"”]+)["”])?/g;
  while ((m = urlRe.exec(text)) !== null) {
    add(m[1].replace(/[.,;)]+$/, ''), m[2] || '');
  }
  const nctRe = /\b(NCT\d{8})\b/gi;
  while ((m = nctRe.exec(text)) !== null) {
    const id = m[1].toUpperCase();
    add(`https://clinicaltrials.gov/study/${id}`, id);
  }
  const pmidRe = /\bPMID[:\s#]*(\d{7,8})\b/gi;
  while ((m = pmidRe.exec(text)) !== null) {
    add(`https://pubmed.ncbi.nlm.nih.gov/${m[1]}/`, `PMID ${m[1]}`);
  }
  const doiRe = /\b(?:doi[:\s]*)(10\.\d{4,9}\/[^\s)\]"']+)/gi;
  while ((m = doiRe.exec(text)) !== null) {
    add(`https://doi.org/${m[1]}`, `DOI ${m[1]}`);
  }
  return refs;
};

/* ==================== Color helpers ==================== */
const ratingColor = (n) => {
  if (n == null) return theme.textDim;
  if (n >= 70) return theme.green;
  if (n >= 40) return theme.yellow;
  return theme.red;
};

// Safety concern uses Low/Moderate/High where higher means more concern.
const SAFETY_BAND_LEVEL = { low: 1, moderate: 2, high: 3 };
const bandColor = (band) => {
  const b = String(band || '').toLowerCase();
  if (b === 'high') return theme.red;
  if (b === 'moderate') return theme.yellow;
  if (b === 'low') return theme.green;
  return theme.textDim;
};
const bandFillPct = (band) => {
  const b = String(band || '').toLowerCase();
  if (b === 'high') return 100;
  if (b === 'moderate') return 60;
  if (b === 'low') return 30;
  return 0;
};
// Parse a "Low|Moderate|High — <justification>" rating. Returns
// { band, note } or null when the value is not a band (legacy % meters).
const parseBandRating = (raw) => {
  const s = String(raw == null ? '' : raw).replace(/\*/g, '').trim();
  const m = s.match(/^(?:Safety concern:\s*)?(Low|Moderate|High|Unknown)\b\s*[—\-–:]?\s*([\s\S]*)$/i);
  if (!m) return null;
  return {
    band: m[1][0].toUpperCase() + m[1].slice(1).toLowerCase(),
    note: m[2].trim()
  };
};
const hasCitableLink = (s) => /\[[^\]]+\]\(https?:\/\/[^)]+\)/i.test(String(s == null ? '' : s));

/* ==================== Storage ==================== */
const loadLS = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const saveLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

// Keep in sync with lib/gather-fingerprint.js + lib/profile-coherence.js
const normProfileKey = (s) => String(s ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
const normProfileList = (value, comma = true) => [...new Set(
  (Array.isArray(value) ? value : [value]).flatMap((entry) =>
    String(entry ?? '').split(comma ? /[,;\n]+/ : /[;\n]+/)
  ).map(normProfileKey).filter(Boolean)
)].sort((a, b) => a.localeCompare(b)).join(';');
const buildGatherFingerprint = (p, resolution) => {
  const fields = {
    condition: normProfileKey(resolution?.resolvedSlug || resolution?.kbSlug || resolution?.resolved || p?.condition),
    gender: normProfileKey(p?.gender), stage: normProfileKey(p?.stage), age: normProfileKey(p?.age),
    weight: normProfileKey(p?.weight), smoking: normProfileKey(p?.smoking), exercise: normProfileKey(p?.exercise),
    diagnoses: normProfileList(p?.diagnoses), medications: normProfileList(p?.medications),
    medicationHistory: normProfileList(p?.medicationHistory), allergies: normProfileList(p?.allergies),
    symptoms: normProfileList(p?.symptoms), labWork: normProfileList(p?.labWork, false),
    scans: normProfileList(p?.scans, false), pregnancyStatus: normProfileKey(p?.pregnancyStatus),
    renalFunction: normProfileKey(p?.renalFunction || p?.renalStatus || p?.kidneyFunction || p?.kidneyStatus || p?.renal),
    hepaticFunction: normProfileKey(p?.hepaticFunction || p?.hepaticStatus || p?.liverFunction || p?.liverStatus || p?.hepatic),
    geneticVariant: normProfileList(p?.geneticVariant), caregiverContext: normProfileKey(p?.caregiverContext)
  };
  return fields.condition
    ? Object.entries(fields).map(([key, value]) => `${key}=${value}`).join('|')
    : 'unknown';
};
const checkProfileCoherence = (p) => {
  const condition = String(p?.condition || '').trim();
  const gender = normProfileKey(p?.gender);
  if (!condition || !gender) return { ok: true };
  if (/\bmale[\s-]*breast\b/i.test(condition) && gender === 'female') {
    return {
      ok: false,
      message: 'Condition says male breast cancer but profile gender is Female. Update the condition or gender, then run again.'
    };
  }
  if (/\bfemale[\s-]*breast\b/i.test(condition) && gender === 'male') {
    return {
      ok: false,
      message: 'Condition says female breast cancer but profile gender is Male. Update the condition or gender, then run again.'
    };
  }
  return { ok: true };
};
const buildProfileIdentityKey = (p) => buildGatherFingerprint(p, null);

// Dorothy language set. We keep English as default and run translation
// on-demand so we don't add cost/latency to every base research call.
const TRANSLATION_LANGS = [
  'English',
  'Spanish',
  'French',
  'Chinese',
  'Japanese',
  'German'
];
const MEDICAL_DISCLAIMER = 'Disclaimer: This is educational medical research support, not medical advice. Please review all information with your licensed medical provider before making treatment decisions.';

/* ============================================================== */
/* ===================== FLOATING CHAT ========================== */
/* ============================================================== */
/* Persistent chat surface anchored to the bottom-right of every
   tab. The in-tab "Follow-up chat" inside ResearchTab stays for
   users who want it inline; this widget is the second surface
   that is available everywhere (Profile, Research, Export & Links).

   Sits ABOVE the sticky red "NOT MEDICAL ADVICE" banner — the
   banner is ~78px on desktop / ~110px on narrow mobile, so the
   FAB and panel use a 100px bottom offset to clear it with a
   comfortable air gap. On iOS, env(safe-area-inset-bottom) plus
   a visualViewport listener push the input above the soft
   keyboard when it pops open.

   History is persisted to localStorage under
   mrt_floating_chat_v1 (last 50 turns) so a refresh / tab switch
   does not wipe the conversation. State is kept entirely on the
   App component so it survives mounting / unmounting of any
   single tab. */
const FLOATING_CHAT_LS_KEY = 'mrt_floating_chat_v1';
const FLOATING_CHAT_QUICK_STARTS = [
  'My mom has LADA and takes insulin twice a day — what should we know?',
  'My dad was just diagnosed with IPF — what are the main treatment options?',
  'She is 65 with type 1 diabetes and kidney disease — any drug interaction worries?',
  'What trials are recruiting for retinitis pigmentosa right now?'
];

const FloatingChat = ({
  open, setOpen,
  history, busy, onSend,
  patient, researchText, repurposeText, trialsText, evidencePack,
  hasUnread
}) => {
  const [draft, setDraft] = useState('');
  const dialogRef = useDialogAccessibility(open, () => setOpen(false));
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined'
           && window.matchMedia
           && window.matchMedia('(max-width: 720px)').matches
  );
  // Bottom inset (px) that the panel pads itself by so the input
  // row stays visible above the iOS soft keyboard. Driven off
  // visualViewport.height vs window.innerHeight.
  const [kbInset, setKbInset] = useState(0);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia('(max-width: 720px)');
    const onChange = (e) => setIsMobile(e.matches);
    try { mql.addEventListener('change', onChange); }
    catch { mql.addListener(onChange); }
    return () => {
      try { mql.removeEventListener('change', onChange); }
      catch { mql.removeListener(onChange); }
    };
  }, []);

  // iOS keyboard inset compensation. visualViewport.height shrinks
  // by the keyboard height when the input is focused; we pad the
  // panel's bottom so the input row floats above the keyboard
  // instead of being hidden behind it.
  useEffect(() => {
    if (!open) { setKbInset(0); return; }
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;
    const recompute = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setKbInset(inset);
    };
    recompute();
    vv.addEventListener('resize', recompute);
    vv.addEventListener('scroll', recompute);
    return () => {
      vv.removeEventListener('resize', recompute);
      vv.removeEventListener('scroll', recompute);
    };
  }, [open]);

  // Auto-scroll to the latest message whenever a turn lands.
  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, history.length, busy]);

  const contextText = useMemo(() => {
    const bits = [];
    const cond = patient?.condition?.trim();
    if (cond) {
      const ageBit = patient.age ? String(patient.age).trim() : '';
      const sexBit = patient.gender
        ? String(patient.gender).trim().charAt(0).toUpperCase()
        : '';
      const dem = `${ageBit}${sexBit}`;
      bits.push(`profile (${cond}${dem ? `, ${dem}` : ''})`);
    }
    const analyses = [];
    if (researchText) analyses.push('research');
    if (repurposeText) analyses.push('repurpose');
    if (trialsText) analyses.push('trials');
    if (analyses.length) {
      bits.push(`${analyses.join(' + ')} analysis`);
    }
    const sources = Math.min((evidencePack || []).length, 18);
    if (sources) bits.push(`${sources} evidence sources`);
    if (!bits.length) return 'Context: no profile yet — ask anything to get started.';
    return 'Context: ' + bits.join(' + ');
  }, [patient, researchText, repurposeText, trialsText, evidencePack]);

  const submit = (overrideText) => {
    const t = (overrideText != null ? overrideText : draft).trim();
    if (!t || busy) return;
    setDraft('');
    onSend(t);
  };

  // ---- Closed state: just the FAB ----
  if (!open) {
    return (
      <button
        type="button"
        aria-label="Open chat assistant"
        onClick={() => setOpen(true)}
        style={{
          position: 'fixed',
          right: 20,
          bottom: 100,
          zIndex: 10000,
          width: 56,
          height: 56,
          borderRadius: '50%',
          background: theme.accent,
          color: theme.primaryText,
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: `0 8px 28px ${theme.accentGlow}, 0 0 0 1px ${theme.accentEdge}`,
          transition: 'transform 0.15s ease, box-shadow 0.15s ease'
        }}
      >
        <MessageCircle size={26} color={theme.primaryText} />
        {hasUnread && (
          <span
            className="mrt-pulse-dot"
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: 6,
              right: 6,
              width: 12,
              height: 12,
              borderRadius: '50%',
              background: theme.secondary,
              border: `2px solid ${theme.panelSolid}`,
              boxShadow: `0 0 8px ${theme.secondary}`
            }}
          />
        )}
      </button>
    );
  }

  // ---- Open state: backdrop (mobile only) + panel ----
  const panelW = isMobile ? 'calc(100vw - 16px)' : 380;
  // Cap height on both axes so the panel never overflows the
  // viewport on short laptop screens. The 160-180px reserve
  // accounts for the bottom disclaimer (~88-130px) plus a
  // breathing margin on the top.
  const panelH = isMobile
    ? `min(70vh, calc(100vh - 160px))`
    : `min(560px, calc(100vh - 180px))`;
  // On mobile we lift the panel as the keyboard rises. On desktop
  // the keyboard concept is irrelevant.
  const panelBottom = isMobile
    ? Math.max(100, kbInset + 20)
    : 100;
  const panelRight = isMobile ? 8 : 20;

  return (
    <>
      {isMobile && (
        <div
          onClick={() => setOpen(false)}
          aria-hidden="true"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9998,
            background: 'rgba(0, 0, 0, 0.35)',
            backdropFilter: 'blur(2px)',
            WebkitBackdropFilter: 'blur(2px)'
          }}
        />
      )}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal={isMobile ? 'true' : 'false'}
        aria-label="AI chat assistant"
        tabIndex="-1"
        style={{
          position: 'fixed',
          right: panelRight,
          bottom: panelBottom,
          width: panelW,
          height: panelH,
          maxWidth: '100vw',
          zIndex: 10001,
          background: theme.panelSolid,
          borderRadius: 14,
          border: `1px solid ${theme.border}`,
          backdropFilter: 'blur(18px)',
          WebkitBackdropFilter: 'blur(18px)',
          boxShadow: `0 24px 60px rgba(0,0,0,0.45), 0 0 0 1px ${theme.border}`,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        }}
      >
        {/* Header */}
        <div style={{
          padding: '0.85rem 1rem',
          borderBottom: `1px solid ${theme.border}`,
          background: theme.accentSoft,
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '0.5rem',
          flexShrink: 0
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              color: theme.accent,
              fontWeight: 700,
              fontSize: '1rem'
            }}>
              <MessageCircle size={18} /> Ask the AI
            </div>
            <div style={{
              color: theme.textDim,
              fontSize: '0.75rem',
              marginTop: 2,
              lineHeight: 1.4
            }}>
              Plain-English questions · profile fills in as you talk
            </div>
          </div>
          <button
            type="button"
            aria-label="Close chat"
            onClick={() => setOpen(false)}
            style={{
              background: 'transparent',
              border: 'none',
              color: theme.text,
              cursor: 'pointer',
              fontSize: '1.5rem',
              lineHeight: 1,
              padding: '0 0.35rem',
              flexShrink: 0
            }}
          >×</button>
        </div>

        {/* Context indicator */}
        <div style={{
          padding: '0.5rem 1rem',
          borderBottom: `1px solid ${theme.border}`,
          color: theme.textDim,
          fontSize: '0.72rem',
          background: theme.panel,
          flexShrink: 0,
          lineHeight: 1.4
        }}>
          {contextText}
        </div>

        {/* Messages */}
        <div
          ref={scrollRef}
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            padding: '0.75rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem'
          }}
        >
          {history.length === 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            <div style={{
              color: theme.textDim,
              fontSize: '0.82rem',
              lineHeight: 1.5,
              marginBottom: 4
            }}>
              Describe the situation in plain English — we update your profile automatically.
              Or tap a suggestion:
            </div>
              {FLOATING_CHAT_QUICK_STARTS.map((p, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    setDraft(p);
                    inputRef.current?.focus();
                  }}
                  style={{
                    ...btn('ghost'),
                    width: '100%',
                    justifyContent: 'flex-start',
                    textAlign: 'left',
                    fontSize: '0.82rem',
                    padding: '0.55rem 0.7rem',
                    whiteSpace: 'normal',
                    lineHeight: 1.4
                  }}
                >
                  {p}
                </button>
              ))}
            </div>
          )}
          {history.map((m, i) => (
            <div
              key={i}
              style={{
                padding: '0.6rem 0.75rem',
                borderRadius: 10,
                maxWidth: '88%',
                alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                background: m.role === 'user' ? theme.accentSoft : theme.panel,
                border: `1px solid ${m.role === 'user' ? theme.accentEdge : theme.border}`
              }}
            >
              <div style={{
                fontSize: '0.7rem',
                color: theme.accent,
                fontWeight: 600,
                marginBottom: 4
              }}>
                {m.role === 'user' ? 'You' : 'Assistant'}
              </div>
              {m.profileNote && (
                <div style={{
                  fontSize: '0.68rem', color: theme.green, marginBottom: 4,
                  padding: '0.2rem 0.45rem', borderRadius: 5,
                  background: `${theme.green}12`, border: `1px solid ${theme.green}33`
                }}>{m.profileNote}</div>
              )}
              {m.role === 'user'
                ? (
                  <div style={{
                    whiteSpace: 'pre-wrap',
                    fontSize: '0.88rem',
                    lineHeight: 1.55
                  }}>{m.content}</div>
                )
                : <Markdown text={m.content} />}
            </div>
          ))}
          {busy && (
            <div style={{
              padding: '0.6rem 0.75rem',
              borderRadius: 10,
              maxWidth: '85%',
              alignSelf: 'flex-start',
              background: theme.panel,
              border: `1px solid ${theme.border}`,
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              color: theme.textDim,
              fontSize: '0.82rem'
            }}>
              <Loader size={14} className="spin" />
              <span>Thinking…</span>
            </div>
          )}
        </div>

        {/* Input row */}
        <div style={{
          padding: '0.6rem 0.7rem',
          paddingBottom: `max(0.6rem, env(safe-area-inset-bottom, 0))`,
          borderTop: `1px solid ${theme.border}`,
          background: theme.panelSolid,
          display: 'flex',
          gap: '0.5rem',
          alignItems: 'flex-end',
          flexShrink: 0
        }}>
          <textarea
            ref={inputRef}
            aria-label="Ask the research assistant"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={
              patient?.condition
                ? `Ask about ${patient.condition}…`
                : 'Type a question…'
            }
            rows={1}
            style={{
              ...inputStyle,
              flex: 1,
              minHeight: 38,
              maxHeight: 120,
              resize: 'none',
              padding: '0.5rem 0.65rem',
              fontSize: '0.88rem',
              lineHeight: 1.4
            }}
          />
          <button
            type="button"
            disabled={busy || !draft.trim()}
            onClick={() => submit()}
            style={{
              ...btn('primary', busy || !draft.trim()),
              padding: '0.55rem 0.85rem',
              fontSize: '0.85rem'
            }}
          >
            {busy
              ? <Loader size={14} className="spin" />
              : <Search size={14} />} Send
          </button>
        </div>
        <div style={{
          padding: '0.45rem 0.85rem',
          borderTop: `1px solid ${theme.border}`,
          fontSize: '0.65rem',
          color: theme.textDim,
          lineHeight: 1.45,
          flexShrink: 0,
          background: theme.panel
        }}>
          {CHAT_SESSION_FOOTNOTE}
        </div>
      </div>
    </>
  );
};

/* ============================================================== */
/* =========================== APP ============================== */
/* ============================================================== */
const EMPTY_PATIENT_PROFILE = Object.freeze({
  condition: '', stage: '',
  age: '', gender: '', weight: '',
  smoking: '', exercise: '',
  diagnoses: '', medications: '', medicationHistory: '', allergies: '',
  symptoms: '', labWork: '', scans: '',
  pregnancyStatus: '', renalFunction: '', hepaticFunction: '',
  geneticVariant: '',
  caregiverContext: ''
});

const APP_LOCAL_DATA_KEYS = Object.freeze([
  'mrt_patient',
  'mrt_audience',
  'mrt_hipaa',
  'mrt_floating_chat_v1',
  'mra-alerts-email',
  'mra-alerts-owner-tokens',
  'mrt-theme-mode'
]);

const eraseApplicationLocalData = () => {
  for (const key of APP_LOCAL_DATA_KEYS) {
    try { localStorage.removeItem(key); } catch {}
  }
};

const App = () => {
  const [tab, setTab] = useState('profile');
  const [feedback, setFeedback] = useState(null);
  const [patient, setPatient] = useState(() => loadLS('mrt_patient', { ...EMPTY_PATIENT_PROFILE }));
  const [audience, setAudience] = useState(() => loadLS('mrt_audience', 'layperson'));
  const [acceptedHipaa, setAcceptedHipaa] = useState(() => loadLS('mrt_hipaa', false));
  // Theme mode. The actual palette lives on module-level mutable
  // bindings (theme/panelStyle/inputStyle/labelStyle/btn) which are
  // rewired by applyThemeMode() BEFORE we setState, so the
  // subsequent re-render reads the flipped styles everywhere.
  const [themeMode, setThemeModeState] = useState(theme.name);
  const setThemeMode = (mode) => {
    applyThemeMode(mode);
    setThemeModeState(mode);
  };

  const [researchText, setResearchText] = useState('');
  const [repurposeText, setRepurposeText] = useState('');
  const [trialsText, setTrialsText] = useState('');
  const [trialsData, setTrialsData] = useState(null);
  const [chatHistory, setChatHistory] = useState([]);
  const [userQuery, setUserQuery] = useState('');
  const [busy, setBusy] = useState(null);
  // Floating chat surface — independent of the in-tab Follow-up
  // Chat (which uses chatHistory above) so the two surfaces don't
  // fight over the same message stream. History is persisted in
  // localStorage so a refresh / tab switch doesn't wipe context.
  const [floatingChatOpen, setFloatingChatOpen] = useState(false);
  const [floatingChatHistory, setFloatingChatHistory] = useState(
    () => loadLS(FLOATING_CHAT_LS_KEY, [])
  );
  const [floatingChatBusy, setFloatingChatBusy] = useState(false);
  const [floatingChatUnread, setFloatingChatUnread] = useState(false);
  const [runtimeConfig, setRuntimeConfig] = useState(null);
  const [usageInfo, setUsageInfo] = useState(null);

  // Cross-AI audit results per mode — a second model independently
  // audits Claude's output against the same evidence pack.
  const [validations, setValidations] = useState({
    research: null, repurpose: null, trials: null
  });
  const [citationAudits, setCitationAudits] = useState({
    research: null, repurpose: null, trials: null
  });
  // Per-run metadata (token usage, model, repurpose quality) — feeds the
  // "incomplete run" drug-coverage warning surfaced in the Research and
  // Repurpose tabs via runMeta.
  const [lastRunMeta, setLastRunMeta] = useState({
    research: null, repurpose: null, trials: null
  });
  const [evidenceSummary, setEvidenceSummary] = useState(null);
  // Methodology transparency state. Surfaces the post-synthesis
  // pipeline-drug coverage audit result (whether any KB-listed
  // drugs were missed and whether a forced re-prompt fired).
  const [coverageAudit, setCoverageAudit] = useState(null);
  const [repurposeDrugScreen, setRepurposeDrugScreen] = useState(null);
  const [evidencePack, setEvidencePack] = useState([]);
  const [dossier, setDossier] = useState(null);
  const [conditionResolution, setConditionResolution] = useState(null);
  const [validationMismatch, setValidationMismatch] = useState({ research: null, repurpose: null });
  const [evidenceGrade, setEvidenceGrade] = useState({ research: null, repurpose: null });
  const [lastGathered, setLastGathered] = useState(null);
  const [repurposeForCondition, setRepurposeForCondition] = useState(null);
  const [savedDemoMeta, setSavedDemoMeta] = useState(null);
  const currentProfileKeyRef = useRef('');

  useEffect(() => {
    const onFeedback = (event) => {
      const detail = event.detail || {};
      setFeedback({ message: detail.message || '', kind: detail.kind || 'info', at: Date.now() });
    };
    window.addEventListener('mrt:user-feedback', onFeedback);
    return () => window.removeEventListener('mrt:user-feedback', onFeedback);
  }, []);

  const clearRunStateForProfileChange = () => {
    setLastGathered(null);
    setResearchText('');
    setRepurposeText('');
    setTrialsText('');
    setRepurposeForCondition(null);
    setTrialsData(null);
    setChatHistory([]);
    setEvidencePack([]);
    setEvidenceSummary(null);
    setEvidenceGrade({ research: null, repurpose: null });
    setValidations({ research: null, repurpose: null, trials: null });
    setCitationAudits({ research: null, repurpose: null, trials: null });
    setValidationMismatch({ research: null, repurpose: null });
    setLastRunMeta({ research: null, repurpose: null, trials: null });
    setDossier(null);
    setRepurposeDrugScreen(null);
    setCoverageAudit(null);
    setProgress(null);
    setSavedDemoMeta(null);
  };

  const eraseLocalData = async () => {
    const confirmed = window.confirm(
      'Reset the demo in this browser? This clears the saved profile, chats, reports, access session, Terms consent, alert email/tokens, and theme. Server alert subscriptions are not deleted.'
    );
    if (!confirmed) return;
    try { await fetch('/api/terms-consent', { method: 'DELETE' }); } catch {}
    try { await fetch('/api/access-session', { method: 'DELETE' }); } catch {}
    eraseApplicationLocalData();
    clearRunStateForProfileChange();
    setPatient({ ...EMPTY_PATIENT_PROFILE });
    setAudience('layperson');
    setAcceptedHipaa(false);
    setFloatingChatHistory([]);
    notifyUser(
      'Demo browser data and session cookies were reset. Email-alert subscriptions must be deleted separately using the private management link saved when you subscribed.',
      'success'
    );
    window.setTimeout(() => window.location.reload(), 50);
  };

  const loadSavedDemo = async () => {
    if (busy) return;
    setBusy('saved-demo');
    try {
      const response = await fetch('/api/demo-readiness?action=saved-report');
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.kind !== 'saved-demo' || data?.live !== false) {
        throw new Error(data?.error || 'Saved demo is unavailable.');
      }
      const demoPatient = { ...SAMPLE_PATIENTS.ipf.data };
      const profileKey = buildProfileIdentityKey(demoPatient);
      lastProfileKeyRef.current = profileKey;
      currentProfileKeyRef.current = profileKey;
      setPatient(demoPatient);
      setResearchText(data.researchText);
      setRepurposeText(data.repurposeText);
      setRepurposeForCondition(demoPatient.condition);
      setTrialsData({ ...data.trials, profileKey, savedDemo: true });
      setTrialsText(data.trials?.note ||
        'Saved demo — not live. No specific supported trial record is included; run a live trial search for current studies.');
      setEvidencePack(Array.isArray(data.evidencePack) ? data.evidencePack : []);
      setValidations(data.audits.validation);
      setCitationAudits(data.audits.citations);
      setCoverageAudit(data.audits.coverage);
      setLastRunMeta({
        research: { profileKey, savedDemo: true },
        repurpose: { profileKey, savedDemo: true },
        trials: { profileKey, savedDemo: true }
      });
      setSavedDemoMeta({
        kind: data.kind,
        label: data.label,
        generatedAt: data.generatedAt,
        reviewedGitSha: data.reviewedGitSha,
        provenanceSeal: data.provenanceSeal
      });
      setTab('research');
      notifyUser('Loaded the clearly labeled saved demo. No live research call was made.', 'info');
    } catch (error) {
      notifyUser(error.message || 'Saved demo is unavailable.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const lastProfileKeyRef = useRef(buildProfileIdentityKey(patient));
  const busyRef = useRef(null);
  useEffect(() => {
    const key = buildProfileIdentityKey(patient);
    currentProfileKeyRef.current = key;
    if (lastProfileKeyRef.current && lastProfileKeyRef.current !== key) {
      clearRunStateForProfileChange();
      notifyUser(
        busyRef.current
          ? 'Your profile changed during the run. The outdated result will not be shown; run again for this profile when the current request stops.'
          : 'Your profile changed, so the previous report was cleared. Run a new report for this profile.',
        'info'
      );
    }
    lastProfileKeyRef.current = key;
  }, [patient]);

  useEffect(() => {
    const cond = (patient.condition || '').trim().toLowerCase();
    if (!cond) return;
    if (repurposeForCondition && repurposeForCondition.toLowerCase() !== cond) {
      setRepurposeText('');
      setRepurposeForCondition(null);
    }
  }, [patient.condition, repurposeForCondition]);

  // Deep-research progress state. When runResearch('research'|'repurpose')
  // is in flight, `progress.active === true` and `progress.steps` tracks
  // each stage of the pipeline (dossier, evidence, trials, synthesis,
  // validation). The DeepResearchProgress component renders a ChatGPT-
  // style stepped progress bar driven off this shape.
  const [progress, setProgress] = useState(null);
  const updateStep = (id, patch) => setProgress(p => {
    if (!p) return p;
    return {
      ...p,
      steps: p.steps.map(s => s.id === id ? { ...s, ...patch } : s)
    };
  });
  const callResearchMode = async (mode, payload = {}) => {
    const r = await fetch('/api/research', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, ...payload })
    });
    const raw = await r.text();
    const d = parseApiJsonResponse(r, raw, {
      timeoutMsg: 'Server timeout. Your last gather may still be cached — try again in a moment.'
    });
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  };

  // Turn plain English ("my mom has LADA…") into profile fields before chat
  // or research runs. Fast regex on the server — no extra LLM call.
  const applyMessageToProfile = async (message) => {
    try {
      const data = await callResearchMode('parse-patient-message', { message, patient });
      if (data.merged && data.patient) {
        setPatient(data.patient);
        if (data.conditionResolution) setConditionResolution(data.conditionResolution);
        return { fieldsUpdated: data.fieldsUpdated || [], patient: data.patient };
      }
    } catch (_) {}
    return { fieldsUpdated: [], patient };
  };

  useEffect(() => saveLS('mrt_patient', patient), [patient]);
  useEffect(() => saveLS('mrt_audience', audience), [audience]);
  useEffect(() => saveLS('mrt_hipaa', acceptedHipaa), [acceptedHipaa]);
  // Persist floating chat history (cap at 50 turns so localStorage
  // doesn't grow unbounded — long sessions still keep useful recent
  // context, and chatHistory.slice(-10) is what we actually send
  // upstream anyway).
  useEffect(() => {
    saveLS(FLOATING_CHAT_LS_KEY, floatingChatHistory.slice(-50));
  }, [floatingChatHistory]);
  // Unread indicator: light up the FAB when an assistant message
  // arrives while the panel is closed; clear it when opened.
  useEffect(() => {
    if (floatingChatOpen) {
      setFloatingChatUnread(false);
      return;
    }
    const last = floatingChatHistory[floatingChatHistory.length - 1];
    if (last && last.role === 'assistant') {
      setFloatingChatUnread(true);
    }
  }, [floatingChatHistory, floatingChatOpen]);
  useEffect(() => {
    const loadRuntime = async () => {
      try {
        const [cfg, usage] = await Promise.all([
          callResearchMode('runtime-config').catch(() => null),
          callResearchMode('usage').catch(() => null)
        ]);
        if (cfg) setRuntimeConfig(cfg);
        if (usage) setUsageInfo(usage);
      } catch (_) {}
    };
    loadRuntime();
  }, []);

  /* -------- Derived / parsed data -------- */
  const treatments = useMemo(
    () => injectApprovedTreatmentStubs(
      parseTreatments(researchText),
      evidenceSummary?.pipelineDrugs,
      evidenceSummary?.fdaLabels
    ),
    [researchText, evidenceSummary]
  );
  const candidates = useMemo(() => {
    const cond = (patient.condition || '').trim().toLowerCase();
    if (repurposeForCondition && repurposeForCondition.toLowerCase() !== cond) return [];
    // Only server-sealed candidates with a specific surviving citation are
    // renderable. Never pad a section or display an uncited idea to hit a count.
    const hasCitation = (c) =>
      extractCitationUrls([
        c.references,
        c.supporting_evidence,
        c.repurpose_rationale,
        c.efficacy_hypothesis,
        c.why_for_this_condition,
        c.what_it_does
      ].filter(Boolean).join(' '))
        .some((u) =>
          /^https?:\/\//i.test(u) &&
          !isGoogleSearchUrl(u) &&
          !isDailyMedSearchUrl(u)
        );
    // A "never-researched" idea is allowed to ship with no link at all — the
    // prompt tells the model to say so honestly rather than invent one for a
    // drug that has zero published research on this condition or pathway.
    // Only ideas claiming actual (even preclinical) condition-specific
    // research need a surviving citation to avoid an unsourced claim.
    let parsed = parseCandidates(repurposeText)
      .map((c) => ({
        ...c,
        _repurpose_section: resolveRepurposeSection(c),
        _item_kind: resolveItemKind(c)
      }))
      .filter((c) => c._repurpose_section === 'no-condition-study-identified' || hasCitation(c));
    const excluded = evidenceSummary?.excludedAgents || [];
    if (excluded.length) {
      const blockNames = excluded.flatMap((x) =>
        [x.name, ...(x.aliases || [])].map((n) => String(n).toLowerCase().trim()).filter(Boolean)
      );
      parsed = parsed.filter((c) => {
        const name = String(c.candidate || '').toLowerCase();
        return !blockNames.some((ex) => name.includes(ex) || ex.includes(name.replace(/[^a-z0-9]/g, '')));
      });
    }
    return parsed;
  }, [repurposeText, evidenceSummary, repurposeForCondition, patient.condition]);
  const trialBlocks = useMemo(() => parseTrialBlocks(trialsText), [trialsText]);
  const combos = useMemo(() => parseCombos(repurposeText), [repurposeText]);
  const references = useMemo(() => {
    const cond = patient.condition || '';
    const all = [
      ...parseReferences(researchText),
      ...parseReferences(repurposeText),
      ...parseReferences(trialsText)
    ];
    const map = new Map();
    const add = (url, quote = '') => {
      const u = String(url || '').trim();
      if (!u || map.has(u)) return;
      // Never list a sickle-cell (wrong-disease) pack title on a non-SCD report.
      if (blobMentionsForeignDisease(`${quote} ${u}`, cond)) return;
      map.set(u, { url: u, quote: quote || u });
    };
    all.forEach(r => add(r.url, r.quote));
    for (const p of evidencePack || []) {
      const titleBlob = `${p.title || ''} ${p.text || ''} ${p.summary || ''}`;
      if (blobMentionsForeignDisease(titleBlob, cond)) continue;
      const u = p.pmcUrl || p.pubmedUrl || p.doiUrl || p.oaUrl || p.landingUrl || p.europePmcUrl || p.url;
      if (u) add(u, p.title || u);
      else if (p.pmid) add(`https://pubmed.ncbi.nlm.nih.gov/${String(p.pmid).replace(/\D/g, '')}/`, p.title || `PMID ${p.pmid}`);
      else if (p.doi) add(`https://doi.org/${String(p.doi).replace(/^https?:\/\/doi\.org\//i, '')}`, p.title || p.doi);
    }
    return [...map.values()];
  }, [researchText, repurposeText, trialsText, evidencePack, patient.condition]);

  /* -------- Actions -------- */
  const runResearch = async (mode, extra = {}) => {
    if (
      (mode === 'research' || mode === 'repurpose' || mode === 'trials') &&
      runtimeConfig?.spendControls?.researchPipeline === false
    ) {
      notifyUser('Research is temporarily unavailable. Please try again later.', 'error');
      return;
    }
    // Research / Repurpose / Trials still require a condition (they
    // do a full 16-section analysis that's meaningless without one).
    // Chat mode is allowed to start cold — the backend will detect
    // a disease name in the user's first message.
    if (mode !== 'chat' && !patient.condition.trim()) {
      notifyUser('Enter a primary condition in the Profile tab first.', 'error');
      setTab('profile');
      return;
    }

    // Resolve condition names before starting any research provider calls.
    // Ambiguous short names return the user to Profile for a full name.
    // Defer setPatient until the run finishes — updating profile identity
    // mid-run clears lastGathered and can drift gather vs synth fingerprints.
    let runPatient = patient;
    let runResolution = conditionResolution;
    let pendingPatientCanonical = extra._pendingPatientCanonical || null;
    if (mode === 'research' || mode === 'repurpose' || mode === 'trials') {
      const typed = patient.condition.trim();
      try {
        const resolution = await callResearchMode('resolve-condition', { condition: typed });
        runResolution = resolution;
        setConditionResolution(resolution);
        if (resolution?.needsConfirmation) {
          const alternatives = Array.isArray(resolution.alternatives)
            ? resolution.alternatives.join(', ')
            : '';
          notifyUser(
            `“${typed}” can mean more than one condition. Please enter or select the full condition name${alternatives ? `, such as ${alternatives}` : ''}.`,
            'error'
          );
          setTab('profile');
          return;
        }
        if (
          runtimeConfig?.conditionInference?.enabled !== false &&
          !resolution?.inferenceDisabled &&
          resolution?.resolved &&
          resolution.resolved !== typed &&
          resolution.matchScore >= 40
        ) {
          runPatient = { ...patient, condition: resolution.resolved };
          pendingPatientCanonical = runPatient;
        }
      } catch (_) { /* proceed with typed condition */ }
    }

    if (mode === 'research' || mode === 'repurpose') {
      const coherence = checkProfileCoherence(runPatient);
      if (!coherence.ok) {
        notifyUser(coherence.message, 'error');
        return;
      }
    }

    const runCondition = runPatient.condition.trim();
    const runFingerprint = buildGatherFingerprint(runPatient, runResolution);
    const runProfileKey = buildProfileIdentityKey(patient);
    const skipGather = extra.skipGather && lastGathered &&
      lastGathered.gatherFingerprint === runFingerprint && (
        lastGathered.mode === mode || extra.reuseGather === true
      );
    const gatheredPools = skipGather ? lastGathered : null;
    if (extra.skipGather && lastGathered && lastGathered.gatherFingerprint !== runFingerprint) {
      setLastGathered(null);
    }

    setValidationMismatch((v) => ({ ...v, [mode]: null }));
    setBusy(mode);
    busyRef.current = mode;
    setLastRunMeta((meta) => ({
      ...meta,
      [mode]: null,
      ...(mode === 'research' && extra.chainRepurpose ? { repurpose: null } : {})
    }));
    if (mode === 'research') {
      setResearchText('');
      if (extra.chainRepurpose) {
        setRepurposeText('');
        setRepurposeForCondition(null);
      }
    }
    if (mode === 'repurpose') {
      setRepurposeText('');
      setRepurposeForCondition(null);
      setRepurposeDrugScreen(null);
    }
    // Seed deep-research progress for research/repurpose (the heavy,
    // multi-phase modes). Chat / trials-analysis stay lightweight and
    // just use the inline spinner.
    const deepMode = (mode === 'research' || mode === 'repurpose');
    if (deepMode) {
      requestAnimationFrame(() => {
        window.scrollTo({ top: 0, behavior: 'instant' });
      });
      setProgress({
        active: true,
        mode,
        startedAt: Date.now(),
        // Three HONEST steps — gather runs dossier+journals+trials together
        // on the server (one API call). Showing 3 fake sequential sub-steps
        // made it look like we jumped straight to "step 3" when gather returned
        // fast from cache. Never lie about what ran.
        steps: [
          { id: 'gather', label: 'Gather research',
            desc: 'Looks up your condition, searches medical journals, and scans ClinicalTrials.gov — all at once.',
            status: 'running' },
          { id: 'synth', label: mode === 'repurpose' ? 'Look at drug ideas' : 'Write your full report',
            desc: mode === 'repurpose'
              ? 'Reviews treatments and supportive care, and includes a combination only when a source studied that exact combination.'
              : 'Prepares a source-linked report for clinician discussion.',
            status: 'pending' }
        ]
      });
    }
    // Match server trimSynthPools so synthesize POST bodies stay small on mobile.
    const slimPoolsForSynth = (pools) => {
      if (!pools) return pools;
      const { dossier, evidence, trials, poolsFingerprint = null } = pools;
      const slimEvidence = evidence ? {
        condition: evidence.condition,
        dossier: evidence.dossier,
        pipelineDrugs: evidence.pipelineDrugs || [],
        excludedAgents: evidence.excludedAgents || [],
        totalUnique: evidence.totalUnique,
        totalFetched: evidence.totalFetched,
        perSourceCounts: evidence.perSourceCounts,
        accessBreakdown: evidence.accessBreakdown,
        promptPackBreakdown: evidence.promptPackBreakdown,
        qualityBreakdown: evidence.qualityBreakdown,
        knowledgeBase: evidence.knowledgeBase,
        fdaLabels: (evidence.fdaLabels || []).slice(0, 4),
        fdaManufacturers: (evidence.fdaManufacturers || []).slice(0, 3),
        groundedForPrompt: (evidence.groundedForPrompt || []).slice(0, 25).map((a) => ({
          ...a,
          text: (a.text || '').slice(0, 1800)
        })),
        topRanked: (evidence.topRanked || []).slice(0, 15).map((a) => ({
          id: a.id, title: a.title, journal: a.journal, year: a.year,
          url: a.url || a.pmcUrl || a.pubmedUrl || a.doiUrl,
          accessLevel: a.accessLevel,
          abstract: (a.abstract || '').slice(0, 800)
        }))
      } : null;
      return {
        dossier: dossier
          ? { ...dossier, poolsFingerprint: dossier.poolsFingerprint || poolsFingerprint || null }
          : null,
        evidence: slimEvidence,
        trials: trials ? {
          total: trials.total,
          returned: trials.returned,
          breakdown: trials.breakdown,
          subQueries: trials.subQueries,
          query: trials.query,
          status: trials.status,
          cancelled: trials.cancelled === true,
          degraded: trials.degraded === true,
          providerErrors: trials.providerErrors,
          studies: (trials.studies || []).slice(0, 20),
          registrySeal: trials.registrySeal
        } : null
      };
    };

    const callResearch = async (payload, retriesLeft = 3) => {
      if (payload.phase === 'synthesize' && !payload.gatherSeal &&
          (payload.providedEvidence || payload.providedTrials)) {
        const slim = slimPoolsForSynth({
          dossier: payload.providedDossier,
          evidence: payload.providedEvidence,
          trials: payload.providedTrials,
          poolsFingerprint: payload.gatherFingerprint
        });
        payload = {
          ...payload,
          providedDossier: slim.dossier,
          providedEvidence: slim.evidence,
          providedTrials: slim.trials
        };
      }
      let res, raw;
      try {
        res = await fetch('/api/research', buildBrowserResearchRequest(payload, {
          profileKey: buildProfileIdentityKey(payload.patient)
        }));
        raw = await res.text();
      } catch (netErr) {
        // The fetch PROMISE rejected — the connection dropped before we
        // got any HTTP response. On mobile Safari this surfaces as
        // "Load failed"; other browsers say "NetworkError"/"fetch
        // failed". This happens on long synthesis calls when the phone
        // sleeps, the cell signal blips, or the socket is closed mid-
        // request. It NEVER reached the server-error retry below, which
        // is why the user saw a dead "Load failed" with no recovery.
        // Every phase here is safe to replay (gather is cached server-
        // side; synthesize is idempotent), so auto-retry with backoff.
        if (retriesLeft > 0) {
          await new Promise(r => setTimeout(r, 1500));
          return callResearch(payload, retriesLeft - 1);
        }
        throw new Error('Your connection dropped while building the report. Your search is saved — tap Run again and it should finish fast.');
      }
      // A retryable failure is a server timeout / 5xx / non-JSON gateway
      // page on a phase whose inputs are cached or idempotent. Auth and
      // billing errors (401/402) must NOT be retried.
      const retryable =
        retriesLeft > 0 &&
        (payload.phase === 'synthesize' || payload.phase === 'gather') &&
        res.status !== 402 && res.status !== 401 && res.status !== 413 &&
        (res.status >= 500 ||
         res.status === 429 ||
         /timeout|FUNCTION_INVOCATION|504|502|529|overloaded|Gateway|empty|unexpected end/i.test(raw || ''));

      let data;
      try {
        data = parseApiJsonResponse(res, raw, {
          timeoutMsg: `Server timeout on the ${payload.phase || 'full'} phase. Your search data is saved — click Run again and it should finish faster (often under 30 seconds).`
        });
      } catch (parseErr) {
        // The Vercel timeout page is HTML, so parsing throws here on a
        // real timeout. Retry instead of surfacing a dead error.
        if (retryable) {
          await new Promise(r => setTimeout(r, 1200));
          return callResearch(payload, retriesLeft - 1);
        }
        throw parseErr;
      }
      if (!res.ok && retryable) {
        await new Promise(r => setTimeout(r, 1200));
        return callResearch(payload, retriesLeft - 1);
      }
      if (!res.ok) {
        if (
          res.status === 409 &&
          ['GATHER_STALE', 'GATHER_SEAL_EXPIRED', 'GATHER_SEAL_INVALID', 'GATHER_POOL_INVALID'].includes(data?.code)
        ) {
          const err = new Error(data.error || 'Profile changed — re-gathering.');
          err.code = 'GATHER_STALE';
          throw err;
        }
        if (data?.upgradeRequired) {
          const p = data?.pricing || {};
          const upgradeUrl = approvedUpgradeUrl(p.upgradeUrl);
          throw new Error(
            `${data.error || 'Usage limit reached.'} ` +
            `Pro: $${p.proPriceUsd || p.paidPriceUsd || 20}/mo → ${p.proRunsPerMonth || p.paidRunsPerMonth || 100} runs. ` +
            `Max: $${p.maxPriceUsd || 79}/mo → ${p.maxRunsPerMonth || 500} runs.` +
            (upgradeUrl ? ` Upgrade: ${upgradeUrl}` : ' Enter an upgrade code on the Profile tab.')
          );
        }
        const errMsg = formatApiError(data, res);
        throw new Error(errMsg);
      }
      return data;
    };
    const packForPolish = (ev) => {
      const merged = [];
      const seen = new Set();
      for (const list of [ev?.groundedForPrompt, ev?.topRanked]) {
        for (const a of list || []) {
          const key = String(a.pmid || a.doi || a.id || a.title || '').toLowerCase();
          if (key && seen.has(key)) continue;
          if (key) seen.add(key);
          merged.push(a);
        }
      }
      return merged.slice(0, 25).map((a) => ({
        id: a.doi || a.pmid || a.id,
        title: a.title,
        journal: a.journal,
        pmid: a.pmid,
        doi: a.doi,
        url: a.pmcUrl || a.pubmedUrl || a.doiUrl || a.oaUrl || a.landingUrl || a.europePmcUrl || a.url,
        pmcUrl: a.pmcUrl,
        pubmedUrl: a.pubmedUrl,
        doiUrl: a.doiUrl,
        accessLevel: a.accessLevel,
        summary: String(a.summary || '').slice(0, 2000),
        keyPassages: Array.isArray(a.keyPassages) ? a.keyPassages.slice(0, 8) : [],
        text: (a.fullText || a.abstract || a.text || a.summary || '').slice(0, 2000)
      }));
    };
    const polishMergedReport = async (text, reportData, gatherContext) => {
      if (!text) return { text: '', validation: null, validationMismatch: null, citationAudit: null, outputArtifact: null };
      let out = text;
      let validation = null;
      let validationMismatch = null;
      let citationAudit = null;
      try {
        // Thread the condition's grounding (canonical facts + KB lifestyle
        // / red-flag guidance) to the server so applyValidationFixes can
        // KEEP a validator-disputed claim that our own ground truth backs
        // (the GERD/87% antacid regression) rather than deleting it.
        const kbForPolish = reportData?.evidence?.knowledgeBase || {};
        const d = await callResearch({
          mode: 'polish-report',
          analysisText: out,
          excludedAgents: reportData?.evidence?.excludedAgents || [],
          evidencePack: packForPolish(reportData?.evidence),
          pipelineDrugs: reportData?.evidence?.pipelineDrugs || [],
          fdaLabels: reportData?.evidence?.fdaLabels || [],
          canonicalFacts: kbForPolish.canonicalFacts || reportData?.evidence?.canonicalFacts || [],
          lifestyle: kbForPolish.lifestyleRecommendations || [],
          redFlags: kbForPolish.redFlags || [],
          trials: reportData?.trials || null,
          patient: runPatient,
          audience,
          condition: runPatient.condition,
          silentFix: true,
          artifactMode: mode,
          sourceArtifacts: reportData?.sourceArtifacts ||
            (reportData?.outputArtifact ? [reportData.outputArtifact] : []),
          gatherSeal: gatherContext?.gatherSeal,
          gatherFingerprint: gatherContext?.gatherFingerprint,
          providedDossier: gatherContext?.dossier,
          providedEvidence: gatherContext?.evidence,
          providedTrials: gatherContext?.trials
        });
        const polished = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
        if (polished) out = polished;
        validation = d.validation || null;
        validationMismatch = d.validationMismatch || null;
        citationAudit = d.citationAudit || null;
        return {
          text: out,
          validation,
          validationMismatch,
          citationAudit,
          outputArtifact: d.outputArtifact || null
        };
      } catch (_) {}
      return { text: out, validation, validationMismatch, citationAudit, outputArtifact: null };
    };
    const countCandidateBlocks = (text) =>
      (String(text || '').match(/^(?:CANDIDATE|Drug or supplement idea):/gim) || []).length;
    // Retry transport/model truncation only. Candidate count is not a
    // quality signal and must never trigger quota-driven generation.
    const laneNeedsRetry = (result, text) => {
      if (!result) return true;
      const stop = result.stop_reason || result.stopReason || '';
      return stop === 'max_tokens' || !String(text || '').trim();
    };
    try {
      // Two-phase for research + repurpose (fan-out is too heavy to
      // finish alongside Claude synthesis in one 60s slot). Chat and
      // trials stay single-shot — their pipelines are much shorter.
      const useTwoPhase = (mode === 'research' || mode === 'repurpose');
      let data;
      let gatherContext = null;
      if (useTwoPhase) {
        const gathered = gatheredPools || await callResearch({
          mode, patient: runPatient, audience, phase: 'gather', ...extra
        });
        gatherContext = {
          gatherSeal: gathered.gatherSeal,
          gatherFingerprint: gathered.gatherFingerprint,
          dossier: gathered.dossier
            ? { ...gathered.dossier, poolsFingerprint: gathered.gatherFingerprint }
            : null,
          evidence: gathered.evidence,
          trials: gathered.trials
        };
        if (currentProfileKeyRef.current && currentProfileKeyRef.current !== runProfileKey) {
          throw new Error('Your profile changed while research was running. The outdated result was discarded; run again for the current profile.');
        }
        const runGatherFingerprint =
          gathered.gatherFingerprint ||
          gathered.dossier?.poolsFingerprint ||
          gatheredPools?.gatherFingerprint ||
          lastGathered?.gatherFingerprint ||
          runFingerprint;
        const poolDossier = gathered.dossier
          ? { ...gathered.dossier, poolsFingerprint: runGatherFingerprint }
          : null;
        if (!gatheredPools) {
          setLastGathered({
            mode,
            condition: runCondition,
            gatherFingerprint: runGatherFingerprint,
            gatherSeal: gathered.gatherSeal,
            dossier: poolDossier,
            evidence: gathered.evidence,
            trials: gathered.trials,
            at: Date.now()
          });
        }
        const synthBase = {
          gatherSeal: gathered.gatherSeal,
          mode, patient: runPatient, audience,
          phase: 'synthesize',
          providedDossier: poolDossier,
          providedEvidence: gathered.evidence,
          providedTrials: gathered.trials,
          ...extra,
          gatherFingerprint: runGatherFingerprint
        };
        // Expose the pools in the UI as soon as phase 1 finishes so
        // the user sees dossier / trials / evidence panels populate
        // before Claude's full narrative arrives.
        if (gathered.trials) setTrialsData(gathered.trials);
        if (gathered.dossier) setDossier(gathered.dossier);
        if (gathered.conditionResolution) setConditionResolution(gathered.conditionResolution);
          if (gathered.evidence) {
          setEvidenceSummary(gathered.evidence);
          setEvidencePack(gathered.evidence.topRanked || []);
          if (gathered.evidence.repurposeDrugScreen) {
            setRepurposeDrugScreen(gathered.evidence.repurposeDrugScreen);
          }
        }
        if ((mode === 'research' || mode === 'repurpose') && gathered.evidenceGrade) {
          setEvidenceGrade((g) => ({ ...g, [mode]: gathered.evidenceGrade }));
        }
        // One honest gather step — all three pools arrive together.
        updateStep('gather', {
          status: 'done',
          detail: (() => {
            const d = gathered.dossier;
            const e = gathered.evidence;
            const t = gathered.trials;
            const parts = [];
            if (d?.canonical) {
              parts.push(d.canonical + (d.cacheHit ? ' (some cached)' : ''));
            }
            if (e) {
              const fetched = e.totalFetched || e.totalUnique || 0;
              const unique = e.totalUnique || 0;
              const pack = e.promptPackBreakdown?.total || 0;
              const web = e.promptPackBreakdown?.perplexityWeb || e.perSourceCounts?.PerplexityWeb || 0;
              parts.push(`${unique} papers (${pack} used in report${web ? `, ${web} from live web` : ''})`);
              if (e.knowledgeBase?.degraded) parts.push('saved references + live journal search');
            }
            if (t?.total) {
              parts.push(`${t.returned || t.total} trials`);
            }
            return parts.length ? parts.join(' · ') : 'Research gathered';
          })()
        });
        updateStep('synth', {
          status: 'running',
          detail: mode === 'research' ? 'Part 1 of 2: your condition, experts, treatments'
            : mode === 'repurpose' ? 'Looking at several groups of drug ideas at once' : undefined
        });
        if (mode === 'research') {
          const front = await callResearch({
            ...synthBase,
            half: 'front'
          });
          updateStep('synth', { status: 'running', detail: 'Part 2 of 2: trials, ways to get the drug, your plan, safety notes' });
          const frontTextForPrior = (front.content || [])
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n');
          const back = await callResearch({
            ...synthBase,
            half: 'back',
            priorText: frontTextForPrior
          });
          // Stitch the two halves back into a single `data` blob
          // so the rest of the pipeline (text extraction, validation
          // display, evidence pack update) is unchanged.
          const frontText = (front.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
          const backText  = (back.content  || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
          const tokensFront = front.usage?.output_tokens || 0;
          const tokensBack  = back.usage?.output_tokens  || 0;
          data = {
            ...back,
            content: [{ type: 'text', text: frontText + '\n\n' + backText }],
            usage: {
              input_tokens:  (front.usage?.input_tokens  || 0) + (back.usage?.input_tokens  || 0),
              output_tokens: tokensFront + tokensBack
            },
            dossier:    back.dossier    || front.dossier,
            evidence:   back.evidence   || front.evidence,
            trials:     back.trials     || front.trials,
            validation: back.validation || front.validation || null,
            citationAudit: back.citationAudit?.status === 'failed' || front.citationAudit?.status === 'failed'
              ? { status: 'failed' }
              : (back.citationAudit || front.citationAudit || null),
            validationMismatch: back.validationMismatch || front.validationMismatch || null,
            sourceArtifacts: [front.outputArtifact, back.outputArtifact].filter(Boolean)
          };
        } else if (mode === 'repurpose') {
          // Use the shared constants — these were previously hardcoded here,
          // so every change to REPURPOSE_PER_LANE was a no-op and the real
          // ceiling stayed at 3x8 regardless of what the constant said.
          const LANE_COUNT = REPURPOSE_LANE_COUNT;
          const PER_LANE = REPURPOSE_PER_LANE;
          // The researched-agents lane fills a whole section on its own, so it
          // asks for the section's cap; the category lanes split their output
          // across both sections and stay smaller.
          const laneSize = (lane) =>
            (lane === REPURPOSE_RESEARCHED_LANE || lane === REPURPOSE_MECHANISTIC_LANE)
              // Ask for more than the section shows: entries are still dropped
              // downstream for lacking a citation or duplicating the other
              // section, and asking for exactly ten delivered seven.
              ? REPURPOSE_SECTION_DISPLAY_CAP + 6
              : PER_LANE;
          const runLane = (lane) => callResearch({
            ...synthBase, half: 'front', batchLane: lane, batchSize: laneSize(lane)
          });
          const textOf = (r) => (r?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');

          let laneResults = await Promise.allSettled(
            Array.from({ length: LANE_COUNT }, (_, lane) => runLane(lane))
          );

          // Retry failed or truncated lanes, never merely short lanes.
          const retryLanes = [];
          for (let i = 0; i < LANE_COUNT; i++) {
            const s = laneResults[i];
            if (s.status === 'rejected') { retryLanes.push(i); continue; }
            const txt = textOf(s.value);
            if (laneNeedsRetry(s.value, txt)) retryLanes.push(i);
          }
          if (retryLanes.length) {
            updateStep('synth', {
              status: 'running',
              detail: `Retrying ${retryLanes.length} incomplete drug batch${retryLanes.length === 1 ? '' : 'es'}…`
            });
            const retried = await Promise.allSettled(retryLanes.map((lane) => runLane(lane)));
            retried.forEach((s, j) => {
              const lane = retryLanes[j];
              if (s.status === 'fulfilled' && s.value) laneResults[lane] = s;
            });
          }

          const dedupKey = (name) => String(name || '')
            .replace(/\(.*?\)/g, ' ')
            .split(/[—–\-:|/]|\d/)[0]
            .toLowerCase().replace(/[^a-z0-9]/g, '').trim();
          const urlsInBlob = (blob) => {
            const out = [];
            const s = String(blob || '');
            const mdRe = /\[[^\]]*\]\((https?:\/\/[^)]+)\)/g;
            let m;
            while ((m = mdRe.exec(s)) !== null) out.push(m[1]);
            const bareRe = /(?<![(\[])(https?:\/\/[^\s)\]"'<>]+)/g;
            while ((m = bareRe.exec(s)) !== null) out.push(m[1]);
            return out;
          };
          const blockHasRealLink = (block) =>
            urlsInBlob(block).some((u) => /^https?:\/\//i.test(u) && !isGoogleSearchUrl(u) && !isDailyMedSearchUrl(u));
          const splitCandBlocks = (txt) =>
            String(txt || '').split(/(?=^(?:CANDIDATE|Drug or supplement idea):\s)/gim)
              .map((p) => p.trim()).filter((p) => /^(?:CANDIDATE|Drug or supplement idea):/im.test(p));
          const distinctLinkedCount = (txt) => {
            const keys = new Set();
            for (const block of splitCandBlocks(txt)) {
              if (!blockHasRealLink(block)) continue;
              const nm = (block.match(/^(?:CANDIDATE|Drug or supplement idea):\s*(.+)$/im) || [])[1];
              const k = dedupKey(nm);
              if (k) keys.add(k);
            }
            return keys.size;
          };

          const back = await callResearch({ ...synthBase, half: 'back' }).catch(() => null);

          // The two condition-specific lanes go first. Each section is capped,
          // and the cap takes what comes first — so with the registry lanes
          // ahead of them, generic agents that recur across unrelated diseases
          // filled the slots and the condition-specific ideas were cut.
          const lanePriority = (lane) =>
            lane === REPURPOSE_RESEARCHED_LANE ? 0 : lane === REPURPOSE_MECHANISTIC_LANE ? 1 : 2;
          const okFronts = laneResults
            .map((s, lane) => ({ s, lane }))
            .filter(({ s }) => s.status === 'fulfilled' && s.value)
            .sort((a, b) => lanePriority(a.lane) - lanePriority(b.lane))
            .map(({ s }) => s.value);
          if (!okFronts.length) {
            const firstErr = laneResults.find(s => s.status === 'rejected');
            throw new Error(firstErr?.reason?.message || 'Drug idea generation failed — please run it again.');
          }

          let frontText = okFronts.map(textOf).join('\n\n');

          const backText = back ? textOf(back) : '';
          const totalCandidates = countCandidateBlocks(frontText);
          const linkedCandidates = distinctLinkedCount(frontText);
          const sumTok = (key) =>
            okFronts.reduce((n, r) => n + (r.usage?.[key] || 0), 0) + (back?.usage?.[key] || 0);
          data = {
            ...(back || okFronts[0]),
            content: [{ type: 'text', text: frontText + (backText ? '\n\n' + backText : '') }],
            usage: { input_tokens: sumTok('input_tokens'), output_tokens: sumTok('output_tokens') },
            dossier: back?.dossier || okFronts[0]?.dossier,
            evidence: back?.evidence || okFronts[0]?.evidence,
            trials: back?.trials || okFronts[0]?.trials,
            validation: back?.validation || okFronts[0]?.validation || null,
            citationAudit: [back, ...okFronts].some((result) => result?.citationAudit?.status === 'failed')
              ? { status: 'failed' }
              : (back?.citationAudit || okFronts[0]?.citationAudit || null),
            validationMismatch: back?.validationMismatch || okFronts[0]?.validationMismatch || null,
            sourceArtifacts: [...okFronts, back]
              .filter(Boolean)
              .map((result) => result.outputArtifact)
              .filter(Boolean),
            repurposeQuality: {
              totalCandidates,
              linkedCandidates,
              lanesRetried: retryLanes.length,
              ok: totalCandidates > 0 && linkedCandidates === totalCandidates
            }
          };
        } else {
          data = await callResearch({ mode, patient, audience, phase: 'synthesize', ...extra });
        }
        updateStep('synth', {
          status: 'running',
          detail: 'Checking links and cleaning up the report…'
        });
      } else {
        data = await callResearch({ mode, patient, audience, ...extra });
      }
      let text = (data.content || [])
        .filter(b => b.type === 'text').map(b => b.text).join('\n');
      if (currentProfileKeyRef.current && currentProfileKeyRef.current !== runProfileKey) {
        throw new Error('Your profile changed while this report was running. The outdated result was not shown; run again for the current profile.');
      }
      const prePolishText = text;
      if (mode === 'research' || mode === 'repurpose' || mode === 'trials') {
        setValidations((v) => ({ ...v, [mode]: { _auditing: true } }));
        updateStep('synth', {
          status: 'running',
          detail: 'Checking facts and cleaning up the report…'
        });
        const polished = await polishMergedReport(text, data, gatherContext);
        text = polished.text;
        if (polished.validation) data.validation = polished.validation;
        if (polished.validationMismatch) data.validationMismatch = polished.validationMismatch;
        if (polished.citationAudit) data.citationAudit = polished.citationAudit;
        data.outputArtifact = polished.outputArtifact;
      }
      if (mode === 'repurpose') {
        const candidateHasLink = (candidate) =>
          /\[[^\]]+\]\(https?:\/\/[^)]+\)/i.test([
            candidate.references,
            candidate.supporting_evidence,
            candidate.repurpose_rationale,
            candidate.efficacy_hypothesis,
            candidate.why_for_this_condition,
            candidate.what_it_does
          ].filter(Boolean).join(' '));
        // "never-researched" ideas are explicitly allowed to ship with no
        // link (the prompt tells the model to say so honestly instead of
        // inventing one) — only ideas claiming actual condition-specific
        // research need a surviving citation. Gating the WHOLE section on
        // whether at least one candidate happens to carry a link wiped out
        // every legitimate never-researched idea whenever none of them did.
        const isSourceSupported = (candidate) =>
          resolveRepurposeSection(candidate) === 'no-condition-study-identified' ||
          candidateHasLink(candidate);
        const survivingFrom = (body) => parseCandidates(body).filter(isSourceSupported);

        let finalCandidates = survivingFrom(text);
        // A late polish pass can rewrite/strip card labels and leave zero
        // parseable ideas even though the sealed synthesis still had them.
        // Prefer the pre-polish body when it still has surviving cards.
        if (finalCandidates.length === 0) {
          const salvage = survivingFrom(prePolishText);
          if (salvage.length > 0) {
            text = prePolishText;
            finalCandidates = salvage;
          }
        }
        data.repurposeQuality = {
          ...(data.repurposeQuality || {}),
          totalCandidates: finalCandidates.length,
          linkedCandidates: finalCandidates.filter(candidateHasLink).length,
          ok: finalCandidates.length > 0
        };
        if (finalCandidates.length === 0) {
          setRepurposeText('No source-supported drug or supplement ideas survived verification for this report.');
          setRepurposeForCondition(runPatient.condition.trim());
          throw new Error(
            'No source-supported drug or supplement ideas survived verification. ' +
            'The report is incomplete and was not marked ready.'
          );
        }
      }
      updateStep('synth', {
        status: 'done',
        detail: 'Your report is ready'
      });
      if (mode === 'research') setResearchText(text);
      if (mode === 'repurpose') {
        setRepurposeText(text);
        setRepurposeForCondition(runPatient.condition.trim());
      }
      if (mode === 'trials') setTrialsText(text);
      if (mode === 'chat') {
        setChatHistory(h => [...h, { role: 'assistant', content: text }]);
      }
      if (mode !== 'chat' && data.validation) {
        setValidations((v) => ({ ...v, [mode]: data.validation }));
      } else if (mode === 'research' || mode === 'repurpose' || mode === 'trials') {
        setValidations((v) => ({ ...v, [mode]: null }));
      }
      if (mode === 'research' || mode === 'repurpose' || mode === 'trials') {
        setCitationAudits((audits) => ({ ...audits, [mode]: data.citationAudit || { status: 'failed' } }));
      }
      if (mode !== 'chat' && data.validationMismatch) {
        setValidationMismatch((v) => ({ ...v, [mode]: data.validationMismatch }));
      }
      if (mode !== 'chat') {
        setLastRunMeta((m) => ({
          ...m,
          [mode]: {
            inputTokens: data.usage?.input_tokens || 0,
            outputTokens: data.usage?.output_tokens || 0,
            model: data.model || '',
            at: Date.now(),
            profileKey: runProfileKey,
            outputArtifact: data.outputArtifact || null,
            repurposeQuality: data.repurposeQuality || null,
            supplementQueries: data.evidence?.supplementGatherQueries?.length || 0
          }
        }));
      }
      if (data.evidence) {
        setEvidenceSummary(data.evidence);
        setEvidencePack(data.evidence.topRanked || []);
      }
      if (mode === 'research' || mode === 'repurpose') {
        setEvidenceGrade((g) => ({ ...g, [mode]: data.evidenceGrade || null }));
      }
      if (data.dossier) {
        setDossier(data.dossier);
      }
      if (data.coverageAudit) {
        setCoverageAudit(data.coverageAudit);
      }
      if (mode === 'repurpose' && data.repurposeDrugScreen) {
        setRepurposeDrugScreen(data.repurposeDrugScreen);
      }
      if (pendingPatientCanonical) setPatient(pendingPatientCanonical);
      if (mode === 'research' && extra.chainRepurpose) {
        await runResearch('repurpose', { skipGather: true, reuseGather: true });
      }
      try {
        setUsageInfo(await callResearchMode('usage'));
      } catch (_) {}
    } catch (e) {
      if (e.code === 'GATHER_STALE' && !extra._gatherRetried) {
        setLastGathered(null);
        return runResearch(mode, {
          ...extra,
          _gatherRetried: true,
          skipGather: false,
          _pendingPatientCanonical: pendingPatientCanonical || extra._pendingPatientCanonical || null
        });
      }
      if (deepMode) {
        setProgress(p => p ? ({
          ...p, active: false, error: e.message,
          steps: p.steps.map(s => s.status === 'running' ? { ...s, status: 'error', detail: e.message } : s)
        }) : null);
      }
      notifyUser(e.message, 'error');
      try {
        setUsageInfo(await callResearchMode('usage'));
      } catch (_) {}
    } finally {
      setBusy(null);
      busyRef.current = null;
      if (deepMode) {
        // Fade out the progress card a beat after completion so the
        // user clearly sees every step hit "done" before it hides.
        setTimeout(() => setProgress(p => p ? ({ ...p, active: false }) : null), 600);
      }
    }
  };

  const runFullAnalysis = async () => {
    // Gather once with repurpose extras so the chained drug-ideas pass can
    // reuse the same sealed evidence without a second multi-minute gather.
    await runResearch('research', { chainRepurpose: true, includeRepurposeExtras: true });
  };

  const runTrialsFetch = async (opts) => {
    if (!patient.condition.trim()) {
      notifyUser('Enter a primary condition in the Profile tab first.', 'error');
      setTab('profile');
      return;
    }
    setBusy('trials-fetch');
    try {
      const res = await fetch('/api/trials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          condition: patient.condition,
          recruitingOnly: opts?.recruitingOnly ?? true,
          treatmentOnly: opts?.treatmentOnly ?? true,
          excludePlacebo: opts?.excludePlacebo ?? false,
          pageSize: 40,
          patientAge: patient.age ?? null,
          patientSex: patient.gender ?? null,
          patient
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Trials fetch failed');
      setTrialsData(data);
    } catch (e) {
      notifyUser(e.message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const runTrialsAnalysis = () => {
    if (!trialsData || !trialsData.studies?.length) {
      notifyUser('Run a full report first so live trials are loaded.', 'error');
      return;
    }
    runResearch('trials', { trialsData });
  };

  // Re-run second-AI check on demand (also runs automatically after every report).
  const auditAnalysis = async (mode, opts = {}) => {
    // opts.text / opts.pack let the auto-verify path pass the FRESH
    // analysis + evidence right after a run (React state is still
    // stale in that closure). opts.silent suppresses the "run first"
    // alert so the automatic trigger can never pop a dialog.
    const analysisText = opts.text || (
      mode === 'research'  ? researchText :
      mode === 'repurpose' ? repurposeText :
      mode === 'trials'    ? trialsText : '');
    const sourcePack = opts.pack || evidencePack;
    if (!analysisText) {
      if (!opts.silent) notifyUser('Run the analysis first, then try again.', 'error');
      return null;
    }
    setValidations((v) => ({ ...v, [mode]: { _auditing: true } }));
    try {
      const packForValidator = (sourcePack || []).slice(0, 18).map((a) => ({
        id: a.doi || a.pmid || a.id,
        title: a.title,
        journal: a.journal,
        tier: a.journalTier,
        year: a.year,
        sources: a.sources,
        accessLevel: a.accessLevel,
        url: a.pmcUrl || a.pubmedUrl || a.doiUrl || a.oaUrl || a.landingUrl || a.europePmcUrl || a.url,
        text: (a.fullText || a.abstract || '').slice(0, 2000)
      }));
      const r = await fetch('/api/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'validate',
          analysisText,
          evidencePack: packForValidator,
          // Grounding for the validator's persistence gate (grounding-gate.js).
          canonicalFacts: evidenceSummary?.knowledgeBase?.canonicalFacts || [],
          lifestyle: evidenceSummary?.knowledgeBase?.lifestyleRecommendations || [],
          redFlags: evidenceSummary?.knowledgeBase?.redFlags || [],
          patient,
          condition: patient.condition || '',
          audience
        })
      });
      const raw = await r.text();
      let data;
      try { data = JSON.parse(raw); }
      catch {
        if (isLocalDevHost() && (r.status === 501 || r.status === 404)) {
          const err = { error: localApiDevHint };
          setValidations((v) => ({ ...v, [mode]: err }));
          return err;
        }
        if (r.status === 501) {
          const err = { error: 'The report-checking service is temporarily unavailable. Try again in one minute or contact support.' };
          setValidations((v) => ({ ...v, [mode]: err }));
          return err;
        }
        const err = { error: 'The report-checking service returned an unexpected response. Please try again.' };
        setValidations((v) => ({ ...v, [mode]: err }));
        return err;
      }
      if (!r.ok) {
        const err = { error: formatApiError(data, r) };
        setValidations((v) => ({ ...v, [mode]: err }));
        return err;
      }
      let fixedText = analysisText;
      if (data.primary && opts.applyFixes !== false) {
        try {
          const fixRes = await fetch('/api/research', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mode: 'polish-report',
              analysisText,
              validation: data,
              validate: false,
              silentFix: true,
              excludedAgents: evidenceSummary?.excludedAgents || [],
              evidencePack: (sourcePack || []).slice(0, 25).map((a) => ({
                title: a.title, url: a.url || a.pubmedUrl || a.doiUrl, pmid: a.pmid, doi: a.doi
              })),
              // Grounding so applyValidationFixes keeps KB-backed claims
              // the validator wrongly disputes (grounding-gate.js).
              canonicalFacts: evidenceSummary?.knowledgeBase?.canonicalFacts || [],
              lifestyle: evidenceSummary?.knowledgeBase?.lifestyleRecommendations || [],
              redFlags: evidenceSummary?.knowledgeBase?.redFlags || [],
              pipelineDrugs: evidenceSummary?.pipelineDrugs || [],
              fdaLabels: evidenceSummary?.fdaLabels || [],
              trials: trialsData || null,
              patient,
              audience,
              condition: patient.condition || ''
            })
          });
          const fixRaw = await fixRes.text();
          const fixData = JSON.parse(fixRaw);
          const polished = (fixData.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
          if (polished) {
            fixedText = polished;
            if (mode === 'research') setResearchText(fixedText);
            if (mode === 'repurpose') setRepurposeText(fixedText);
            if (mode === 'trials') setTrialsText(fixedText);
          }
        } catch (_) {}
      }
      setValidations((v) => ({ ...v, [mode]: data }));
      if (data.validationMismatch) {
        setValidationMismatch((v) => ({ ...v, [mode]: data.validationMismatch }));
      }
      return data;
    } catch (err) {
      const errObj = { error: err.message };
      setValidations((v) => ({ ...v, [mode]: errObj }));
      return errObj;
    }
  };

  const sendChat = async () => {
    if (!userQuery.trim()) return;
    const q = userQuery.trim();
    setUserQuery('');
    const { fieldsUpdated, patient: chatPatient } = await applyMessageToProfile(q);
    setChatHistory(h => [...h, {
      role: 'user',
      content: q,
      profileNote: fieldsUpdated.length
        ? `Saved to your profile: ${fieldsUpdated.join(', ')}`
        : null
    }]);
    setBusy('chat');
    try {
      // Pass the prior analyses + cached evidence pack so chat mode
      // has real context to answer from. Before this, chat ran with no
      // evidence pack and no memory of prior research output, which is
      // why follow-ups often came back as "can't compute" hedges.
      const packForChat = (evidencePack || []).slice(0, 18).map((a) => ({
        id: a.doi || a.pmid || a.id,
        title: a.title,
        journal: a.journal,
        tier: a.journalTier,
        year: a.year,
        sources: a.sources,
        accessLevel: a.accessLevel,
        url: a.pmcUrl || a.pubmedUrl || a.doiUrl || a.oaUrl || a.landingUrl || a.europePmcUrl,
        text: (a.fullText || a.abstract || '').slice(0, 2500)
      })).filter((a) => a.title && !blobMentionsForeignDisease(
        `${a.title || ''} ${a.text || ''}`,
        chatPatient.condition || patient.condition || ''
      ));

      const res = await fetch('/api/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'chat', patient: chatPatient, audience, userQuery: q,
          chatHistory: chatHistory.slice(-10),
          priorAnalyses: {
            research: researchText || undefined,
            repurpose: repurposeText || undefined,
            trials: trialsText || undefined
          },
          evidencePack: packForChat
        })
      });
      const raw = await res.text();
      const data = parseApiJsonResponse(res, raw, {
        timeoutMsg: 'The server took too long. Try again — your research should still be saved, so the next try will be faster.'
      });
      if (!res.ok) {
        const errMsg = data?.error?.message || data?.error || 'Chat failed';
        throw new Error(typeof errMsg === 'string' ? errMsg : 'Chat failed');
      }
      const text = stripForeignDiseaseContamination(
        (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n'),
        chatPatient.condition || patient.condition || ''
      );
      setChatHistory(h => [...h, { role: 'assistant', content: text }]);
    } catch (e) {
      setChatHistory(h => [...h, { role: 'assistant', content: 'Error: ' + e.message }]);
    } finally {
      setBusy(null);
    }
  };

  // Floating chat send. Mirrors sendChat's payload shape so the
  // backend's chat-mode handler can use the same priorAnalyses +
  // evidencePack context, but is fully independent of the in-tab
  // chat state so the two surfaces don't stomp on each other.
  const sendFloatingChat = async (text) => {
    const q = String(text || '').trim();
    if (!q || floatingChatBusy) return;
    const baseHistory = floatingChatHistory.slice(-10);
    const { fieldsUpdated, patient: chatPatient } = await applyMessageToProfile(q);
    setFloatingChatHistory(h => [...h, {
      role: 'user',
      content: q,
      profileNote: fieldsUpdated.length
        ? `Saved to profile: ${fieldsUpdated.join(', ')}`
        : null
    }]);
    setFloatingChatBusy(true);
    try {
      const packForChat = (evidencePack || []).slice(0, 18).map((a) => ({
        id: a.doi || a.pmid || a.id,
        title: a.title,
        journal: a.journal,
        tier: a.journalTier,
        year: a.year,
        sources: a.sources,
        accessLevel: a.accessLevel,
        url: a.pmcUrl || a.pubmedUrl || a.doiUrl || a.oaUrl || a.landingUrl || a.europePmcUrl,
        text: (a.fullText || a.abstract || '').slice(0, 2500)
      })).filter((a) => a.title && !blobMentionsForeignDisease(
        `${a.title || ''} ${a.text || ''}`,
        chatPatient.condition || patient.condition || ''
      ));
      const res = await fetch('/api/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'chat', patient: chatPatient, audience, userQuery: q,
          chatHistory: baseHistory,
          priorAnalyses: {
            research: researchText || undefined,
            repurpose: repurposeText || undefined,
            trials: trialsText || undefined
          },
          evidencePack: packForChat
        })
      });
      // Robust non-JSON handling: Vercel's 60s timeout returns a
      // plaintext FUNCTION_INVOCATION_TIMEOUT page, not JSON.
      // Detect that and surface a friendlier message instead of
      // 'Unexpected token A ... is not valid JSON'.
      const raw = await res.text();
      const data = parseApiJsonResponse(res, raw, {
        timeoutMsg: 'The server took too long. Try again in a moment — your research should still be saved, so the next try will be faster.'
      });
      if (!res.ok) {
        const errMsg = data?.error?.message || data?.error || 'Chat failed';
        throw new Error(typeof errMsg === 'string' ? errMsg : 'Chat failed');
      }
      const answer = stripForeignDiseaseContamination(
        (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n'),
        chatPatient.condition || patient.condition || ''
      );
      setFloatingChatHistory(h => [...h, { role: 'assistant', content: answer }]);
    } catch (e) {
      setFloatingChatHistory(h => [...h, { role: 'assistant', content: 'Error: ' + e.message }]);
    } finally {
      setFloatingChatBusy(false);
    }
  };

  const canonicalReportModel = useMemo(() => buildCanonicalReportModel({
    patient,
    researchText,
    repurposeText,
    treatments,
    candidates,
    combos,
    trialsData,
    trialsText,
    references,
    evidenceSummary,
    evidencePack
  }), [
    patient, researchText, repurposeText, treatments, candidates, combos,
    trialsData, trialsText, references, evidenceSummary, evidencePack
  ]);

  const requestReportCompletionContract = useCallback(async (surface = 'full') => {
    const response = await fetch('/api/report-completion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        surface,
        termsVersion: MRT_TERMS_VERSION,
        artifacts: {
          research: lastRunMeta.research?.outputArtifact || null,
          repurpose: lastRunMeta.repurpose?.outputArtifact || null
        },
        trialsPayload: trialsData,
        savedDemo: savedDemoMeta?.provenanceSeal
          ? { provenanceSeal: savedDemoMeta.provenanceSeal }
          : null
      })
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.contract || !result?.seal) {
      const reasons = [
        ...(result?.contract?.missingMessages || []),
        ...(result?.contract?.failedMessages || [])
      ];
      throw new Error(reasons.length
        ? `This report is not ready to export. ${reasons.join(' ')}`
        : 'The report could not be verified for export. Please try again.');
    }
    return {
      ...result.contract,
      seal: result.seal,
      canonicalContent: result.canonicalContent
    };
  }, [
    lastRunMeta,
    trialsData,
    savedDemoMeta
  ]);

  return (
    <div style={{ minHeight: '100vh', background: theme.bg,
      fontFamily: '"Crimson Pro", Georgia, serif', color: theme.text }}>
      <Header patient={patient} audience={audience} setAudience={setAudience}
        themeMode={themeMode} setThemeMode={setThemeMode}
        runtimeConfig={runtimeConfig} usageInfo={usageInfo}
        refreshUsage={async () => {
          try { setUsageInfo(await callResearchMode('usage')); } catch (_) {}
        }} />
      <div style={{ maxWidth: 1400, margin: '0 auto', padding: '1.5rem 2rem' }}>
        <Tabs tab={tab} setTab={setTab} />

        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: '0.6rem', flexWrap: 'wrap', margin: '0.25rem 0 1rem'
        }}>
          <FullReportExportButton
            patient={patient}
            researchText={researchText}
            repurposeText={repurposeText}
            treatments={treatments}
            candidates={candidates}
            combos={combos}
            trialsData={trialsData}
            trialsText={trialsText}
            references={references}
            evidenceSummary={evidenceSummary}
            evidencePack={evidencePack}
            reportModel={canonicalReportModel}
            appBusy={busy}
            getCompletionContract={requestReportCompletionContract}
          />
          <button type="button" onClick={loadSavedDemo} disabled={!!busy}
            style={btn('ghost', !!busy)}>
            Load saved demo (not live)
          </button>
        </div>

        {savedDemoMeta && (
          <div role="status" style={{
            ...panelStyle,
            border: `2px solid ${theme.yellow}`,
            color: theme.text,
            marginBottom: '1rem'
          }}>
            <strong style={{ color: theme.yellow }}>{savedDemoMeta.label}</strong>
            <div style={{ marginTop: 4, fontSize: '0.82rem', color: theme.textDim }}>
              Saved on {new Date(savedDemoMeta.generatedAt).toLocaleDateString()}.
              This example was not generated during this session and is not live.
            </div>
          </div>
        )}

        <main id={`mrt-panel-${tab}`} role="tabpanel" aria-labelledby={`mrt-tab-${tab}`} tabIndex="-1">
        {tab === 'profile' && <PatientTab patient={patient} setPatient={setPatient}
          audience={audience} setAudience={setAudience}
          setTab={setTab} runResearch={runFullAnalysis} busy={busy}
          applyMessageToProfile={applyMessageToProfile}
          runtimeConfig={runtimeConfig} usageInfo={usageInfo}
          acceptedHipaa={acceptedHipaa} setAcceptedHipaa={setAcceptedHipaa}
          refreshUsage={async () => {
            try { setUsageInfo(await callResearchMode('usage')); } catch (_) {}
          }} />}
        {tab === 'research' && <ResearchTab
          patient={patient} audience={audience} busy={busy} runResearch={runFullAnalysis}
          researchText={researchText} treatments={treatments}
          candidates={candidates} combos={combos} repurposeText={repurposeText}
          trialsData={trialsData} drugScreen={repurposeDrugScreen}
          validation={validations.research}
          validationMismatch={validationMismatch.research}
          evidenceGrade={evidenceGrade.research || evidenceGrade.repurpose}
          conditionResolution={conditionResolution}
          evidenceSummary={evidenceSummary}
          evidencePack={evidencePack}
          dossier={dossier} progress={progress} coverageAudit={coverageAudit}
          onRetrySynth={() => runResearch('research', { skipGather: true })}
          canRetrySynth={
            !!lastGathered?.mode &&
            lastGathered.mode === 'research' &&
            lastGathered.gatherFingerprint === buildGatherFingerprint(patient, conditionResolution)
          }
          chatHistory={chatHistory} userQuery={userQuery}
          setUserQuery={setUserQuery} sendChat={sendChat}
          onAudit={() => auditAnalysis('research')}
          runtimeConfig={runtimeConfig}
          runMeta={{
            ...lastRunMeta.research,
            repurposeQuality: lastRunMeta.repurpose?.repurposeQuality || null,
            supplementQueries: lastRunMeta.repurpose?.supplementQueries || 0
          }}
          getCompletionContract={requestReportCompletionContract}
          setTab={setTab}
          onDismissMismatch={() => setValidationMismatch((v) => ({ ...v, research: null }))} />}
        {tab === 'refs' && <RefsTab references={references} evidencePack={evidencePack} evidenceSummary={evidenceSummary} trialsData={trialsData} />}
        </main>
      </div>
      <Footer runtimeConfig={runtimeConfig} onEraseLocalData={eraseLocalData} />
      <div
        role={feedback?.kind === 'error' ? 'alert' : 'status'}
        aria-live={feedback?.kind === 'error' ? 'assertive' : 'polite'}
        aria-atomic="true"
        style={{
          position: 'fixed', right: 18, bottom: 98, zIndex: 10015,
          maxWidth: 460, padding: feedback ? '0.75rem 2.4rem 0.75rem 0.9rem' : 0,
          borderRadius: 9, border: feedback ? `1px solid ${feedback.kind === 'error' ? theme.red : theme.accent}` : 'none',
          background: theme.panelSolid, color: feedback?.kind === 'error' ? theme.red : theme.text,
          boxShadow: feedback ? '0 10px 30px rgba(0,0,0,0.35)' : 'none'
        }}
      >
        {feedback?.message || ''}
        {feedback && (
          <button type="button" aria-label="Dismiss message" onClick={() => setFeedback(null)}
            style={{ position: 'absolute', top: 6, right: 7, border: 0, background: 'transparent', color: theme.text, cursor: 'pointer', fontSize: '1.1rem' }}>×</button>
        )}
      </div>
      {/* Floating chat — available on Profile, Research, and Export & Links.
          In-tab follow-up chat on Research stays too. */}
      <FloatingChat
        open={floatingChatOpen}
        setOpen={setFloatingChatOpen}
        history={floatingChatHistory}
        busy={floatingChatBusy}
        onSend={sendFloatingChat}
        patient={patient}
        researchText={researchText}
        repurposeText={repurposeText}
        trialsText={trialsText}
        evidencePack={evidencePack}
        hasUnread={floatingChatUnread}
      />
    </div>
  );
};

/* ==================== Header ==================== */
// Account controls are intentionally absent until real authentication exists.
const loadStoredUser = () => {
  return null;
};

const Header = ({ patient, audience, setAudience, themeMode, setThemeMode, runtimeConfig, usageInfo }) => {
  const isLight = themeMode === 'light';

  // Theme-aware header chrome. In dark we keep the deep-navy glass
  // bar; in light we use a near-white frosted bar with a soft slate
  // border. The "pulse bar" beneath the header is our signature
  // identity touch — cyan fading to amber — visible in both modes.
  const headerBg = isLight ? 'rgba(255, 255, 255, 0.88)' : 'rgba(9, 20, 26, 0.92)';
  const headerShadow = isLight
    ? '0 1px 0 rgba(15,23,42,0.04), 0 4px 18px rgba(15,23,42,0.06)'
    : '0 1px 0 rgba(255,255,255,0.02), 0 4px 24px rgba(0,0,0,0.35)';
  const softPanelBg = isLight ? 'rgba(15,23,42,0.04)' : 'rgba(255,255,255,0.03)';
  const userMenuBg = isLight ? '#ffffff' : '#0b1f2a';
  const optionBg = isLight ? '#ffffff' : '#0b1f2a';

  return (
    <>
      <header style={{
        position: 'sticky', top: 0, zIndex: 20,
        background: headerBg,
        borderBottom: `1px solid ${theme.border}`,
        backdropFilter: 'blur(12px)',
        boxShadow: headerShadow
      }}>
        <div style={{
          maxWidth: 1400, margin: '0 auto',
          padding: '0.75rem 1.5rem',
          display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap'
        }}>
          {/* Brand mark + wordmark */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', minWidth: 0, flexShrink: 1 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10,
              background: `linear-gradient(135deg, ${theme.accent} 0%, ${theme.secondary} 100%)`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: `0 2px 8px ${theme.accentGlow}`
            }}>
              <Activity size={20} color={theme.primaryText} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', minWidth: 0 }}>
                <span style={{
                  fontFamily: '"Crimson Pro", Georgia, serif',
                  fontWeight: 700, fontSize: '1.1rem', color: theme.text, letterSpacing: '-0.01em',
                  overflowWrap: 'anywhere', minWidth: 0
                }}>
                  {runtimeConfig?.branding?.productName || 'Researching My Condition'}
                </span>
                <span style={{
                  fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.08em',
                  padding: '0.12rem 0.4rem', borderRadius: 4,
                  background: theme.secondarySoft, color: theme.secondary,
                  border: `1px solid ${theme.secondary}55`, textTransform: 'uppercase',
                  flexShrink: 0
                }}>
                  Beta
                </span>
              </div>
              <span style={{ fontSize: '0.72rem', color: theme.textDim, overflowWrap: 'anywhere' }}>
                AI-assisted condition research, trials, and treatment discovery
              </span>
            </div>
          </div>

          {/* Center context chip (what we're researching) */}
          {patient?.condition ? (
            <div style={{
              marginLeft: '0.5rem', display: 'none',
              padding: '0.3rem 0.65rem', borderRadius: 999,
              background: theme.accentSoft, border: `1px solid ${theme.accentEdge}`,
              color: theme.accent, fontSize: '0.78rem', fontWeight: 600,
              maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
            }} className="mrt-condition-chip">
              Researching: {patient.condition}
            </div>
          ) : null}

          <div style={{ flex: 1 }} />

          {/* Audience switcher (quiet, small) */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: '0.4rem',
            padding: '0.3rem 0.5rem', borderRadius: 8,
            background: softPanelBg,
            border: `1px solid ${theme.border}`,
            flexShrink: 0
          }}>
            <label htmlFor="mrt-header-reading-level" style={{ fontSize: '0.72rem', color: theme.textDim, fontWeight: 600 }}>Report style</label>
            <select id="mrt-header-reading-level" value={audience} onChange={e => setAudience(e.target.value)}
              style={{
                background: 'transparent', color: theme.text, border: 'none',
                fontFamily: 'inherit', fontSize: '0.8rem', fontWeight: 600,
                outline: 'none', cursor: 'pointer', padding: '0 0.2rem'
              }}>
              <option value="layperson" style={{ background: optionBg, color: theme.text }}>Plain language (default)</option>
              <option value="medical"   style={{ background: optionBg, color: theme.text }}>Clinical detail</option>
            </select>
          </div>

          {/* Free-use pill. Uses theme.green (adjusted per palette)
              so it stays readable against both backgrounds. */}
          <div style={{
            padding: '0.3rem 0.65rem', borderRadius: 999,
            flexShrink: 0,
            background: (usageInfo?.usage?.remaining <= 0 && !usageInfo?.usage?.unlimited && usageInfo?.usage?.plan !== 'dev')
              ? `${theme.yellow}22` : `${theme.green}22`,
            border: `1px solid ${(usageInfo?.usage?.remaining <= 0 && !usageInfo?.usage?.unlimited && usageInfo?.usage?.plan !== 'dev')
              ? `${theme.yellow}55` : `${theme.green}55`}`,
            color: (usageInfo?.usage?.remaining <= 0 && !usageInfo?.usage?.unlimited && usageInfo?.usage?.plan !== 'dev')
              ? theme.yellow : theme.green,
            fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.03em',
            display: 'inline-flex', alignItems: 'center', gap: '0.3rem'
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: 999,
              background: (usageInfo?.usage?.remaining <= 0 && !usageInfo?.usage?.unlimited && usageInfo?.usage?.plan !== 'dev')
                ? theme.yellow : theme.green,
              display: 'inline-block'
            }} />
            {usageInfo?.usage?.plan === 'dev' || usageInfo?.usage?.unlimited
              ? ((typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname))
                ? 'Local · unlimited runs'
                : 'Unlimited runs')
              : usageInfo?.usage
                ? (usageInfo.usage.remaining <= 0
                  ? `${usageInfo.usage.plan === 'max' ? 'Max' : usageInfo.usage.plan === 'pro' || usageInfo.usage.plan === 'paid' ? 'Pro' : 'Free'} · no searches remaining`
                  : `${usageInfo.usage.plan === 'pro' || usageInfo.usage.plan === 'max' || usageInfo.usage.plan === 'paid' ? (usageInfo.usage.plan === 'max' ? 'Max' : 'Pro') : 'Free'} plan · ${usageInfo.usage.remaining}/${usageInfo.usage.limit} searches left`)
                : 'Free plan'}
          </div>

        </div>
        {/* Signature "pulse bar" — tiny cyan→amber gradient strip
            that makes the top of the app instantly recognisable as
            OURS rather than a generic AI product. */}
        <div className="mrt-pulse-bar" />
        {/* Secondary bar: currently-researching chip, only visible on narrow screens */}
        {patient?.condition && (
          <div style={{
            maxWidth: 1400, margin: '0 auto', padding: '0.4rem 1.5rem 0.5rem',
            fontSize: '0.78rem', color: theme.textDim
          }}>
            <span style={{ color: theme.textDim }}>Researching:</span>{' '}
            <span style={{ color: theme.accent, fontWeight: 600 }}>{patient.condition}</span>
          </div>
        )}
      </header>

    </>
  );
};

// Inactive prototype retained only to avoid unrelated structural churn.
const LegacyAccountPrototype = ({ onClose, onSuccess }) => {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [mode, setMode] = useState('existing');
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const submit = (e) => {
    e?.preventDefault();
    if (!emailOk) return;
    onSuccess({ email: email.trim(), name: name.trim() || email.trim().split('@')[0], createdAt: new Date().toISOString() });
  };
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(3,10,14,0.7)',
      backdropFilter: 'blur(6px)', zIndex: 10020,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem'
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 420, background: theme.panelSolid,
        borderRadius: 14, border: `1px solid ${theme.border}`,
        padding: '1.75rem',
        boxShadow: theme.name === 'light'
          ? '0 24px 64px rgba(15,23,42,0.18)'
          : '0 24px 64px rgba(0,0,0,0.6)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.75rem' }}>
          <div style={{
            width: 34, height: 34, borderRadius: 10,
            background: `linear-gradient(135deg, ${theme.accent} 0%, ${theme.secondary} 100%)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>
            <Activity size={18} color={theme.primaryText} />
          </div>
          <div>
            <h3 style={{ margin: 0, fontSize: '1.05rem', color: theme.text, fontFamily: '"Crimson Pro", Georgia, serif' }}>
              Accounts unavailable
            </h3>
            <p style={{ margin: 0, fontSize: '0.78rem', color: theme.textDim }}>
              This inactive account prototype is not shown to users.
            </p>
          </div>
        </div>
        <form onSubmit={submit}>
          {mode === 'new' && (
            <div style={{ marginBottom: '0.7rem' }}>
              <label style={labelStyle}>Name</label>
              <input value={name} onChange={e => setName(e.target.value)}
                style={inputStyle} placeholder="Dr. Jane Doe" autoFocus />
            </div>
          )}
          <div style={{ marginBottom: '0.7rem' }}>
            <label style={labelStyle}>Email</label>
            <input value={email} onChange={e => setEmail(e.target.value)}
              type="email" style={inputStyle} placeholder="you@hospital.org"
              autoFocus={mode === 'existing'} />
          </div>
          <button type="submit" disabled={!emailOk} style={{
            ...btn('primary', !emailOk), width: '100%', justifyContent: 'center',
            marginTop: '0.5rem'
          }}>
            <LogIn size={14} /> Continue
          </button>
        </form>
        <p style={{ marginTop: '0.9rem', marginBottom: 0, textAlign: 'center', fontSize: '0.78rem', color: theme.textDim }}>
          Account access is not available.{' '}
          <button type="button" onClick={() => setMode(m => m === 'existing' ? 'new' : 'existing')}
            style={{ background: 'transparent', border: 'none', color: theme.accent, cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit', fontSize: '0.78rem' }}>
            Account options
          </button>
        </p>
        <p style={{ marginTop: '0.75rem', marginBottom: 0, fontSize: '0.7rem', color: theme.textDim, textAlign: 'center', fontStyle: 'italic' }}>
          This is a local-only demo identity stored in your browser. We do not sync accounts to our servers yet.
        </p>
      </div>
    </div>
  );
};

/* ==================== Account Settings ====================
   Scope (per product decision): account = IDENTITY + BILLING only.
   We deliberately store NO medical / PHI here — clinical details live
   only on-device in the Patient Profile tab and are never attached to
   the account. This panel handles the non-medical stuff: who you are
   (name/email, local-only for now) and your plan/billing (current
   plan, runs used, and upgrade-code activation). */
const AccountSettingsModal = ({ user, setUser, usageInfo, refreshUsage, runtimeConfig, onClose }) => {
  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [savedMsg, setSavedMsg] = useState('');
  const [code, setCode] = useState('');
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeMsg, setCodeMsg] = useState('');
  const [codeErr, setCodeErr] = useState('');

  const usage = usageInfo?.usage;
  const unlimited = !!(usage?.unlimited || usage?.plan === 'dev');
  const planLabel = unlimited
    ? 'Unlimited'
    : usage?.plan
      ? usage.plan.charAt(0).toUpperCase() + usage.plan.slice(1)
      : 'Free';
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  const tiers = runtimeConfig?.monetization?.tiers || [
    { id: 'free', label: 'Free', runsPerMonth: runtimeConfig?.monetization?.freeRunsPerMonth ?? 4, priceUsd: 0 },
    { id: 'pro', label: 'Pro', runsPerMonth: runtimeConfig?.monetization?.proRunsPerMonth ?? runtimeConfig?.monetization?.paidRunsPerMonth ?? 100, priceUsd: runtimeConfig?.monetization?.proPriceUsd ?? runtimeConfig?.monetization?.paidPriceUsd ?? 20 },
    { id: 'max', label: 'Max', runsPerMonth: runtimeConfig?.monetization?.maxRunsPerMonth ?? 500, priceUsd: runtimeConfig?.monetization?.maxPriceUsd ?? 79 }
  ];

  const saveProfile = () => {
    const next = { ...(user || {}), name: name.trim() || email.trim().split('@')[0], email: email.trim() };
    setUser(next);
    setSavedMsg('Saved');
    setTimeout(() => setSavedMsg(''), 2000);
  };

  const applyCode = async () => {
    if (!code.trim()) { setCodeErr('Enter your upgrade code first.'); return; }
    setCodeBusy(true); setCodeErr(''); setCodeMsg('');
    try {
      const r = await fetch('/api/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'activate-plan', code: code.trim() })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setCode('');
      await (refreshUsage ? refreshUsage() : Promise.resolve());
      const tier = d?.plan || d?.usage?.plan || 'paid';
      setCodeMsg(`${tier.charAt(0).toUpperCase()}${tier.slice(1)} plan activated for this device/IP.`);
    } catch (err) {
      setCodeErr(err.message || 'Upgrade failed');
    } finally {
      setCodeBusy(false);
    }
  };

  const sectionStyle = {
    border: `1px solid ${theme.border}`, borderRadius: 10,
    padding: '1rem 1.1rem', marginTop: '0.9rem', background: theme.accentSoft
  };
  const sectionTitle = {
    margin: '0 0 0.2rem', fontSize: '0.7rem', fontWeight: 700,
    letterSpacing: '0.06em', textTransform: 'uppercase', color: theme.textDim
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(3,10,14,0.7)',
      backdropFilter: 'blur(6px)', zIndex: 10020,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem'
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 480, maxHeight: '90vh', overflowY: 'auto',
        background: theme.panelSolid, borderRadius: 14,
        border: `1px solid ${theme.border}`, padding: '1.6rem',
        boxShadow: theme.name === 'light' ? '0 24px 64px rgba(15,23,42,0.18)' : '0 24px 64px rgba(0,0,0,0.6)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.6rem', marginBottom: '0.4rem' }}>
          <h3 style={{ margin: 0, fontSize: '1.1rem', color: theme.text, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Settings size={18} color={theme.accent} /> Account settings
          </h3>
          <button onClick={onClose} aria-label="Close" style={{
            background: 'transparent', border: 'none', color: theme.textDim,
            cursor: 'pointer', fontSize: '1.1rem', lineHeight: 1, padding: '0.2rem'
          }}>×</button>
        </div>

        {/* PHI boundary notice — the whole point of the scope decision. */}
        <div style={{
          display: 'flex', gap: '0.5rem', alignItems: 'flex-start',
          padding: '0.6rem 0.7rem', borderRadius: 8, fontSize: '0.78rem',
          background: `${theme.green}14`, border: `1px solid ${theme.green}44`,
          color: theme.text, lineHeight: 1.45
        }}>
          <Shield size={15} color={theme.green} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>Your account stores only your name, email, and plan — <strong>never medical information</strong>. Clinical details you enter stay on this device in the Patient Profile tab and are not linked to your account.</span>
        </div>

        {/* Identity */}
        <div style={sectionStyle}>
          <div style={sectionTitle}>Profile</div>
          <div style={{ marginBottom: '0.6rem' }}>
            <label style={labelStyle}>Name</label>
            <input value={name} onChange={e => setName(e.target.value)} style={inputStyle} placeholder="Your name" />
          </div>
          <div style={{ marginBottom: '0.6rem' }}>
            <label style={labelStyle}>Email</label>
            <input value={email} onChange={e => setEmail(e.target.value)} type="email" style={inputStyle} placeholder="you@example.com" />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <button onClick={saveProfile} disabled={!emailOk} style={btn('primary', !emailOk)}>Save profile</button>
            {savedMsg && <span style={{ fontSize: '0.78rem', color: theme.green, fontWeight: 600 }}>{savedMsg}</span>}
          </div>
          <p style={{ margin: '0.6rem 0 0', fontSize: '0.7rem', color: theme.textDim, fontStyle: 'italic' }}>
            Account editing is not available until real authentication is launched.
          </p>
        </div>

        {/* Billing / plan */}
        <div style={sectionStyle}>
          <div style={sectionTitle}>Plan &amp; billing</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '1.05rem', fontWeight: 700, color: theme.text }}>{planLabel} plan</span>
            {!unlimited && usage && (
              <span style={{ fontSize: '0.82rem', color: theme.textDim }}>
                {usage.remaining}/{usage.limit} runs left this month
              </span>
            )}
            {unlimited && (
              <span style={{ fontSize: '0.82rem', color: theme.green, fontWeight: 600 }}>Unlimited runs</span>
            )}
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.7rem' }}>
            {tiers.map((t) => (
              <div key={t.id} style={{
                flex: '1 1 120px', padding: '0.55rem 0.65rem', borderRadius: 8,
                border: `1px solid ${theme.border}`, background: theme.panel
              }}>
                <div style={{ fontSize: '0.82rem', fontWeight: 700, color: theme.text }}>{t.label}</div>
                <div style={{ fontSize: '0.74rem', color: theme.textDim }}>
                  {t.priceUsd ? `$${t.priceUsd}/mo` : 'Free'} · {t.runsPerMonth}/mo
                </div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: '0.85rem' }}>
            <label style={labelStyle}>Have an upgrade code?</label>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <input value={code} onChange={e => setCode(e.target.value)}
                style={{ ...inputStyle, flex: '1 1 160px' }} placeholder="Enter code"
                onKeyDown={e => { if (e.key === 'Enter') applyCode(); }} />
              <button onClick={applyCode} disabled={codeBusy} style={btn('primary', codeBusy)}>
                {codeBusy ? 'Activating…' : 'Apply'}
              </button>
            </div>
            {codeMsg && <p style={{ margin: '0.5rem 0 0', fontSize: '0.78rem', color: theme.green, fontWeight: 600 }}>{codeMsg}</p>}
            {codeErr && <p style={{ margin: '0.5rem 0 0', fontSize: '0.78rem', color: theme.red, fontWeight: 600 }}>{codeErr}</p>}
          </div>
          <p style={{ margin: '0.7rem 0 0', fontSize: '0.7rem', color: theme.textDim, fontStyle: 'italic' }}>
            Online card billing isn&apos;t live yet — paid plans are activated by code for now. Enterprise plans available — contact us. Provider data handling depends on current provider terms and configured account controls.
          </p>
        </div>
      </div>
    </div>
  );
};

/* ==================== Terms of Use gate ==================== */
const TermsOfUseBody = () => (
  <div style={{ maxHeight: '42vh', overflowY: 'auto', paddingRight: '0.35rem', lineHeight: 1.6 }}>
    {TERMS_OF_USE_SECTIONS.map((s, i) => (
      <div key={i} style={{ marginBottom: '0.85rem' }}>
        <div style={{ fontWeight: 700, color: theme.text, fontSize: '0.88rem', marginBottom: '0.25rem' }}>{s.title}</div>
        <div style={{ color: theme.textDim, fontSize: '0.82rem' }}>{s.body}</div>
      </div>
    ))}
    <p style={{ margin: 0, fontSize: '0.78rem', color: theme.textDim, fontStyle: 'italic' }}>
      Full text also available at{' '}
      <a href="/terms" target="_blank" rel="noopener noreferrer" style={{ color: theme.accent }}>
        researchingmycondition.com/terms
      </a>
    </p>
  </div>
);

const TermsModal = ({ mode = 'accept', checked, setChecked, onAccept, onDecline, onClose }) => {
  const close = onClose || onDecline;
  const dialogRef = useDialogAccessibility(true, close);
  return (
  <div style={{
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.88)', zIndex: 10020,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1.25rem'
  }}>
    <div ref={dialogRef} tabIndex="-1" style={{ ...panelStyle, maxWidth: 680, width: '100%', background: theme.panelSolid, maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}
      role="dialog" aria-modal="true" aria-labelledby="mrt-terms-title">
      <h2 id="mrt-terms-title" style={{ marginTop: 0, color: theme.accent, display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '1.15rem' }}>
        <Shield size={22} /> Terms of Use
      </h2>
      <p style={{ color: theme.textDim, fontSize: '0.85rem', marginTop: 0 }}>
        Please read before using this educational research tool. By continuing you agree to these terms.
      </p>
      <TermsOfUseBody />
      {mode === 'accept' && (
        <>
          <label style={{
            display: 'flex', alignItems: 'flex-start', gap: '0.55rem', marginTop: '0.75rem',
            fontSize: '0.85rem', color: theme.text, cursor: 'pointer'
          }}>
            <input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)}
              style={{ marginTop: 3, accentColor: theme.accent }} />
            <span>I have read and understand these Terms of Use. I am 18 or older (or using this with a guardian who accepts on my behalf).</span>
          </label>
          <div style={{ display: 'flex', gap: '0.6rem', marginTop: '1rem', flexWrap: 'wrap' }}>
            <button style={btn('primary', !checked)} disabled={!checked} onClick={onAccept}>
              I understand and agree
            </button>
            <button style={btn('ghost', false)} onClick={onDecline}>Decline</button>
          </div>
        </>
      )}
      {mode === 'view' && (
        <div style={{ marginTop: '1rem' }}>
          <button style={btn('primary', false)} onClick={onClose}>Close</button>
        </div>
      )}
    </div>
  </div>
  );
};

const TermsAcceptanceGate = ({ children }) => {
  const [accepted, setAccepted] = useState(null);
  const [checked, setChecked] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);
  const [error, setError] = useState('');

  const checkTerms = async () => {
    try {
      const r = await fetchGateRequest('/api/terms-consent', { cache: 'no-store' });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || `Terms check failed (HTTP ${r.status})`);
      setAccepted(data.accepted === true);
      setError('');
    } catch (err) {
      setAccepted(false);
      setError(err?.message || 'Could not verify Terms acceptance.');
    }
  };

  useEffect(() => {
    checkTerms();
    const onRequired = () => setAccepted(false);
    window.addEventListener('mrt:terms-required', onRequired);
    return () => window.removeEventListener('mrt:terms-required', onRequired);
  }, []);

  const acceptTerms = async () => {
    setError('');
    try {
      const r = await fetchGateRequest('/api/terms-consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accepted: true, termsVersion: MRT_TERMS_VERSION })
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || `Acceptance failed (HTTP ${r.status})`);
      saveLS('mrt_hipaa', true);
      setAccepted(true);
    } catch (err) {
      setError(err?.message || 'Could not record Terms acceptance.');
    }
  };

  const openTerms = () => setViewOpen(true);

  if (accepted === null) {
    return <div role="status" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: theme.textDim }}>Checking Terms acceptance…</div>;
  }

  if (declined) {
    return (
      <>
        <div style={{
          minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '2rem', background: theme.bg, color: theme.text
        }}>
          <div style={{ ...panelStyle, maxWidth: 520, textAlign: 'center' }}>
            <AlertCircle size={32} color={theme.red} style={{ marginBottom: '0.75rem' }} />
            <h2 style={{ marginTop: 0, color: theme.text }}>Terms not accepted</h2>
            <p style={{ color: theme.textDim, lineHeight: 1.6 }}>
              You must accept the Terms of Use to use this tool. Close this window or contact{' '}
              <a href="mailto:shaque025@gmail.com" style={{ color: theme.accent }}>shaque025@gmail.com</a>.
            </p>
            <button style={btn('primary', false)} onClick={() => { setDeclined(false); setChecked(false); }}>
              Review Terms again
            </button>
          </div>
        </div>
        <StickyDisclaimer />
      </>
    );
  }

  if (!accepted) {
    return (
      <>
        <TermsModal
          mode="accept"
          checked={checked}
          setChecked={setChecked}
          onAccept={acceptTerms}
          onDecline={() => setDeclined(true)}
        />
        {error && <div role="alert" style={{ position: 'fixed', left: '50%', bottom: '5rem', transform: 'translateX(-50%)', zIndex: 10030, color: '#fecaca', background: '#7f1d1d', padding: '0.7rem 1rem', borderRadius: 8 }}>{error}</div>}
        <StickyDisclaimer />
      </>
    );
  }

  return (
    <TermsContext.Provider value={{ openTerms }}>
      {children}
      {viewOpen && (
        <TermsModal mode="view" onClose={() => setViewOpen(false)} />
      )}
    </TermsContext.Provider>
  );
};

/* ==================== HIPAA reminder (profile only) ==================== */
const HipaaProfileReminder = ({ acceptedHipaa, setAcceptedHipaa }) => {
  const { openTerms } = React.useContext(TermsContext);
  return (
    <div style={{
      marginTop: '1.25rem', padding: '0.9rem', background: 'rgba(248, 113, 113, 0.1)',
      border: '1px solid rgba(248, 113, 113, 0.3)', borderRadius: 8
    }}>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
        <AlertCircle size={18} color="#f87171" style={{ flexShrink: 0, marginTop: 2 }} />
        <div style={{ flex: 1 }}>
          <p style={{ margin: '0 0 0.5rem', fontSize: '0.85rem', color: theme.text }}>
            <strong style={{ color: '#f87171' }}>Privacy reminder:</strong> This tool does not follow HIPAA (the U.S. law that protects your health records).
            Do not type anything that could identify a person (name, birth date, medical record number, phone, or address). Use initials or &ldquo;Patient A&rdquo; instead.
            {' '}<button type="button" onClick={openTerms} style={{
              background: 'transparent', border: 'none', color: theme.accent,
              cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit', fontSize: '0.85rem', padding: 0
            }}>See Terms of Use</button> for the full disclaimer.
          </p>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.45rem', fontSize: '0.82rem', color: theme.textDim, cursor: 'pointer' }}>
            <input type="checkbox" checked={acceptedHipaa}
              onChange={e => setAcceptedHipaa(e.target.checked)}
              style={{ marginTop: 3, accentColor: theme.accent }} />
            <span>I understand this tool does not follow HIPAA, and I will not type anything that could identify a person.</span>
          </label>
        </div>
      </div>
    </div>
  );
};

/* ==================== HIPAA Gate (legacy — replaced by TermsAcceptanceGate) ==================== */
const HipaaGate = ({ onAccept }) => (
  <div style={{
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 10020,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem'
  }}>
    <div style={{ ...panelStyle, maxWidth: 720, background: theme.panelSolid }}>
      <h2 style={{ marginTop: 0, color: '#ff8b5a', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <AlertCircle size={24} /> Privacy & HIPAA Warning
      </h2>
      <p><strong>This tool is NOT HIPAA compliant.</strong> It is a research prototype. Do not enter
      real, identifying patient information unless you understand and accept that:</p>
      <ul style={{ color: theme.textDim, lineHeight: 1.7 }}>
        <li>What you type is sent to an outside AI service and to medical databases (ClinicalTrials.gov, PubMed).</li>
        <li>There is no Business Associate Agreement (BAA) in place.</li>
        <li><strong>Do not enter personal identifiers</strong> — no name, date of birth, MRN, address, or phone. Enter only the condition and general profile needed for research.</li>
        <li>Output is research information only — not medical advice, not a diagnosis, and not a second opinion. Final decisions require a physician.</li>
      </ul>
      <p style={{ color: theme.textDim, fontSize: '0.85rem' }}>
        By continuing you acknowledge these limitations.
      </p>
      <button style={btn('primary')} onClick={onAccept}>I Understand — Continue</button>
    </div>
  </div>
);

/* ==================== Tabs ==================== */
const Tabs = ({ tab, setTab }) => {
  // Single-page demo mode: everything lives on Research (Dorothy feedback Jun 2026).
  const tabs = [
    { id: 'profile',   label: 'Profile',         icon: FileText },
    { id: 'research',  label: 'Research report', icon: Brain },
    { id: 'refs',      label: 'Sources & exports', icon: Book }
  ];
  return (
    <nav aria-label="Research workspace">
    <div role="tablist" aria-label="Research sections" style={{
      display: 'flex', gap: '0.15rem', marginBottom: '1.5rem', flexWrap: 'wrap',
      padding: '0.3rem', borderRadius: 10,
      background: theme.panel,
      border: `1px solid ${theme.border}`
    }}>
      {tabs.map(t => {
        const Icon = t.icon;
        const active = tab === t.id;
        return (
          <button key={t.id} id={`mrt-tab-${t.id}`} type="button" role="tab"
            aria-selected={active} aria-controls={`mrt-panel-${t.id}`} tabIndex={active ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const current = tabs.findIndex((item) => item.id === t.id);
              const next = event.key === 'Home' ? 0
                : event.key === 'End' ? tabs.length - 1
                : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
              setTab(tabs[next].id);
              requestAnimationFrame(() => document.getElementById(`mrt-tab-${tabs[next].id}`)?.focus());
            }}
            style={{
            padding: '0.55rem 0.9rem', background: active ? theme.accentSoft : 'transparent',
            border: 'none', borderRadius: 7,
            color: active ? theme.accent : theme.textDim, cursor: 'pointer', fontSize: '0.85rem',
            fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem',
            fontFamily: 'inherit', transition: 'all 0.15s ease',
            boxShadow: active ? `inset 0 0 0 1px ${theme.accentEdge}` : 'none'
          }} onMouseEnter={e => { if (!active) e.currentTarget.style.color = theme.text; }}
             onMouseLeave={e => { if (!active) e.currentTarget.style.color = theme.textDim; }}>
            <Icon size={15} /> {t.label}
          </button>
        );
      })}
    </div>
    </nav>
  );
};

/* ==================== Sample patients ==================== */
// Fictional demo profiles used by the "Load sample" buttons. These are
// NOT real patients — they're illustrative cases the user can load to
// see how the tool reasons about a realistic clinical picture. No PHI
// should ever be entered into this prototype.
const SAMPLE_PATIENTS = {
  ipf: {
    label: 'IPF — moderate, interaction-aware',
    icon: '🫁',
    data: {
      condition: 'Idiopathic Pulmonary Fibrosis',
      stage: 'GAP Stage II (moderate)',
      age: '68',
      gender: 'Male',
      weight: '175 lb / 79 kg',
      smoking: 'Former smoker, 30 pack-years, quit 2010',
      exercise: 'Walks 20 minutes daily; breathless on stairs',
      diagnoses: 'GERD, hypertension, hyperlipidemia',
      medications: 'Pantoprazole 40 mg daily, lisinopril 10 mg daily, atorvastatin 20 mg nightly',
      symptoms: 'Progressive exertional dyspnea, dry cough, fatigue',
      labWork: 'FVC 68% predicted; DLCO 48% predicted',
      scans: 'HRCT: definite UIP pattern with basal honeycombing and traction bronchiectasis',
      geneticVariant: 'Not tested'
    }
  },
  ipfAdvanced: {
    label: 'IPF — advanced',
    icon: '🫁',
    data: {
      condition: 'Idiopathic Pulmonary Fibrosis',
      stage: 'GAP Stage III (severe)',
      age: '74',
      gender: 'Female',
      weight: '132 lb / 60 kg',
      smoking: 'Never smoker; lived with smoker spouse 40 years',
      exercise: 'Short walks around house; uses supplemental O2 at 2 L/min on exertion',
      diagnoses: 'Osteoporosis, atrial fibrillation (on anticoagulation), mild CKD stage 3a, depression',
      medications: 'Pirfenidone 801 mg TID, apixaban 5 mg BID, metoprolol succinate 50 mg daily, alendronate 70 mg weekly, sertraline 50 mg daily, calcium 600 mg + vitamin D3 1000 IU daily',
      symptoms: 'Dyspnea at rest worsening over 6 months, chronic dry cough, severe fatigue, weight loss 8 lb in 4 months',
      labWork: 'FVC 46% predicted, DLCO 28% predicted, 6MWT 220 m with desat to 82% on 2 L/min O2, SpO2 resting 91% on room air',
      scans: 'HRCT 1/2026: end-stage honeycomb lung, traction bronchiectasis, no acute consolidation, normal heart size',
      geneticVariant: 'TERT pathogenic variant on panel — short telomere syndrome. Relevant for transplant evaluation and family screening.'
    }
  },
  rpUsher: {
    label: 'Retinitis pigmentosa — USH2A',
    icon: '👁️',
    data: {
      condition: 'Retinitis Pigmentosa',
      stage: 'Mid-stage; central acuity preserved, peripheral field under 20 degrees',
      age: '34',
      gender: 'Female',
      diagnoses: 'USH2A-associated retinitis pigmentosa',
      medications: 'No prescription eye treatment',
      symptoms: 'Night blindness and progressive peripheral-field loss',
      geneticVariant: 'Biallelic pathogenic USH2A variants'
    }
  },
  t2dCkd: {
    label: 'Type 2 diabetes — CKD medication safety',
    icon: '💉',
    data: {
      condition: 'Type 2 Diabetes',
      stage: 'With chronic kidney disease stage 3b',
      age: '62',
      gender: 'Female',
      diagnoses: 'Type 2 diabetes, CKD stage 3b, hypertension',
      medications: 'Metformin 500 mg twice daily, empagliflozin 10 mg daily, losartan 50 mg daily',
      symptoms: 'No acute symptoms',
      labWork: 'A1c 7.8%; eGFR 38 mL/min/1.73m2'
    }
  },
  lada: {
    label: 'LADA — caregiver demo',
    icon: '💉',
    data: {
      condition: 'Latent autoimmune diabetes in adults',
      stage: '',
      age: '62',
      gender: 'Female',
      weight: '',
      smoking: 'Never',
      exercise: '',
      diagnoses: '',
      medications: 'Insulin glargine at bedtime; rapid-acting insulin with meals',
      symptoms: '',
      labWork: 'C-peptide low; GAD65 antibodies positive',
      scans: '',
      geneticVariant: '',
      caregiverContext: 'Researching for my mom'
    }
  },
  empty: {
    label: 'Clear form',
    icon: '🧹',
    data: {
      condition: '', stage: '', age: '', gender: '', weight: '', smoking: '',
      exercise: '', diagnoses: '', medications: '', symptoms: '', labWork: '', scans: '',
      geneticVariant: '', caregiverContext: ''
    }
  }
};

const PROFILE_DESCRIBE_EXAMPLES = [
  'My mom has LADA and takes insulin twice a day',
  '65-year-old man with IPF on pirfenidone',
  'My daughter has retinitis pigmentosa, age 34'
];

/* ==================== Patient Tab ==================== */
const PatientTab = ({ patient, setPatient, audience, setAudience, setTab, runResearch, busy, applyMessageToProfile, runtimeConfig, usageInfo, refreshUsage, acceptedHipaa, setAcceptedHipaa }) => {
  const { openTerms } = React.useContext(TermsContext);
  const set = (k, v) => setPatient(p => ({ ...p, [k]: v }));
  const [upgradeCode, setUpgradeCode] = useState('');
  const [upgradeBusy, setUpgradeBusy] = useState(false);
  const [describeText, setDescribeText] = useState('');
  const [describeBusy, setDescribeBusy] = useState(false);
  const [describeNote, setDescribeNote] = useState('');
  const [subtypeListing, setSubtypeListing] = useState(null);
  const subtypeDebounce = React.useRef(null);

  React.useEffect(() => {
    const q = (patient.condition || '').trim();
    clearTimeout(subtypeDebounce.current);
    if (runtimeConfig?.conditionInference?.subtypePicker === false || q.length < 2) {
      setSubtypeListing(null);
      return;
    }
    subtypeDebounce.current = setTimeout(async () => {
      try {
        const data = await callResearchMode('condition-subtypes', { query: q });
        setSubtypeListing(data?.matched ? data : null);
      } catch {
        setSubtypeListing(null);
      }
    }, 220);
    return () => clearTimeout(subtypeDebounce.current);
  }, [patient.condition, runtimeConfig?.conditionInference?.subtypePicker]);

  const pickConditionSubtype = (item) => {
    if (!item?.resolved) return;
    setPatient((p) => ({
      ...p,
      condition: item.resolved,
      geneticVariant: item.gene && !String(p.geneticVariant || '').trim()
        ? item.gene
        : p.geneticVariant
    }));
    setSubtypeListing(null);
  };
  const loadSample = (key) => {
    const s = SAMPLE_PATIENTS[key];
    if (!s) return;
    setPatient((_p) => ({ ...s.data }));
  };
  const startResearch = () => {
    if (runtimeConfig?.spendControls?.researchPipeline === false) {
      notifyUser('Research is temporarily unavailable. Please try again later.', 'error');
      return;
    }
    if (!patient.condition?.trim()) {
      notifyUser('Enter a primary condition first, or describe the situation in the box below.', 'error');
      return;
    }
    setTab && setTab('research');
    requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    setTimeout(() => runResearch && runResearch(), 50);
  };
  const fillFromDescription = async () => {
    const msg = describeText.trim();
    if (!msg || !applyMessageToProfile) return;
    setDescribeBusy(true);
    setDescribeNote('');
    try {
      const { fieldsUpdated } = await applyMessageToProfile(msg);
      if (fieldsUpdated.length) {
        setDescribeNote(`Filled in: ${fieldsUpdated.join(', ')}. Check the fields below and edit anything we got wrong.`);
        setDescribeText('');
      } else {
        setDescribeNote('We could not pick out a condition or medicines from that — try a sentence like "My mom has LADA and takes insulin twice a day."');
      }
    } catch (e) {
      setDescribeNote('Could not parse that — try again or fill the fields manually.');
    } finally {
      setDescribeBusy(false);
    }
  };
  const activatePaidPlan = async () => {
    if (!upgradeCode.trim()) { notifyUser('Enter your upgrade code first.', 'error'); return; }
    setUpgradeBusy(true);
    try {
      const result = await callResearchMode('activate-plan', { code: upgradeCode.trim() });
      setUpgradeCode('');
      await (refreshUsage ? refreshUsage() : Promise.resolve());
      const tier = result?.plan || result?.usage?.plan || 'paid';
      notifyUser(`${tier.charAt(0).toUpperCase()}${tier.slice(1)} plan activated for this device.`, 'success');
    } catch (err) {
      notifyUser(err.message || 'Upgrade failed.', 'error');
    } finally {
      setUpgradeBusy(false);
    }
  };
  const tiers = runtimeConfig?.monetization?.tiers || [
    { id: 'free', label: 'Free', runsPerMonth: runtimeConfig?.monetization?.freeRunsPerMonth ?? 4, priceUsd: 0 },
    { id: 'pro', label: 'Pro', runsPerMonth: runtimeConfig?.monetization?.proRunsPerMonth ?? runtimeConfig?.monetization?.paidRunsPerMonth ?? 100, priceUsd: runtimeConfig?.monetization?.proPriceUsd ?? runtimeConfig?.monetization?.paidPriceUsd ?? 20 },
    { id: 'max', label: 'Max', runsPerMonth: runtimeConfig?.monetization?.maxRunsPerMonth ?? 500, priceUsd: runtimeConfig?.monetization?.maxPriceUsd ?? 79 }
  ];
  const upgradeUrl = approvedUpgradeUrl(runtimeConfig?.monetization?.upgradeUrl);
  const privatePreviewUnlimited = runtimeConfig?.monetization?.privatePreviewUnlimited === true;
  const fmtTierPrice = (t) => t.priceUsd ? `$${t.priceUsd}/mo` : 'Free';
  const clinicalPlaceholders = profileClinicalPlaceholders(patient);
  const safetyFields = profileSafetyFields(patient);
  // `type` can be 'text' | 'number' | 'select'. Select fields also
  // supply `options` (array of {value,label}). Most free-form clinical
  // context stays as textarea so clinicians can paste from notes.
  const fields = [
    { k: 'condition',  l: 'Main condition you want to research',   ta: false,
      ph: 'e.g. Retinitis Pigmentosa — then pick a subtype below if you know it', enterSubmits: true,
      subtypePicker: true },
    { k: 'stage',      l: 'Stage of the disease (if you know it)',     ta: false, ph: clinicalPlaceholders.stage },
    { k: 'age',        l: 'Age',                              ta: false, ph: 'e.g. 65', type: 'number' },
    { k: 'gender',     l: 'Sex / Gender',                     ta: false, type: 'select',
      options: [
        { value: '',                 label: 'Select…' },
        { value: 'Female',           label: 'Female' },
        { value: 'Male',             label: 'Male' },
        { value: 'Intersex',         label: 'Intersex' },
        { value: 'Prefer not to say', label: 'Prefer not to say' }
      ] },
    { k: 'weight',     l: 'Weight',                           ta: false, ph: 'e.g. 170 lb / 77 kg' },
    { k: 'smoking',    l: 'Smoking history',                  ta: false, ph: 'e.g. Former, 20 pack-years, quit 2015' },
    { k: 'exercise',   l: 'Exercise / activity',        ta: false, ph: 'e.g. Walks 30 min daily' },
    { k: 'diagnoses',  l: 'All your current health conditions',            ta: true,
      ph: 'Separate them with commas. We do not research these — we use them to check for safety problems.' },
    { k: 'medications',l: 'Medicines you take now',              ta: true,
      ph: 'List every medicine you take — prescriptions, over-the-counter pills, and supplements. We use this to check for drug interactions (when two medicines affect each other).' },
    { k: 'allergies', l: 'Medicine and other allergies', ta: true,
      ph: 'List medicine, ingredient, and other relevant allergies. Enter “none known” only if that is accurate.' },
    { k: 'medicationHistory', l: 'Treatments tried before', ta: true,
      ph: 'Include prior medicines or treatments and why they stopped, if known.' },
    { k: 'symptoms',   l: 'Symptoms you have now',                 ta: true },
    { k: 'labWork',    l: 'Relevant test results',  ta: true,
      ph: clinicalPlaceholders.labWork },
    { k: 'scans',      l: 'Relevant scans or imaging',           ta: true,
      ph: clinicalPlaceholders.scans },
    { k: 'geneticVariant', l: 'Gene test result (if you have one)', ta: true,
      ph: clinicalPlaceholders.geneticVariant }
  ];
  return (
    <div style={panelStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h2 style={{ margin: 0, color: theme.accent, fontSize: '1.3rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <FileText size={22} /> Patient Profile
        </h2>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <label htmlFor="mrt-profile-reading-level" style={{ fontSize: '0.85rem', color: theme.textDim }}>Explain results as:</label>
          <select id="mrt-profile-reading-level" value={audience} onChange={e => setAudience(e.target.value)}
            style={{ ...inputStyle, width: 'auto', padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}>
            <option value="layperson">Everyday words (no medical training)</option>
            <option value="medical">Medical professional</option>
          </select>
        </div>
      </div>
      <p style={{ color: theme.textDim, fontSize: '0.9rem', marginTop: 0 }}>
        You only need a <strong>main condition</strong>. Or describe the situation in plain English below —
        like telling a doctor about your mom — and we fill in the form for you.
      </p>
      {runtimeConfig?.spendControls?.researchPipeline === false && (
        <div style={{
          marginBottom: '1rem', padding: '0.75rem 0.9rem', borderRadius: 8,
          border: `1px solid ${theme.amber || '#f59e0b'}66`,
          background: `${theme.amber || '#f59e0b'}14`, color: theme.text, fontSize: '0.85rem', lineHeight: 1.5
        }}>
          <strong>Research is temporarily unavailable.</strong> You can still review the site and your profile. Try running research again later.
        </div>
      )}

      <div style={{
        marginBottom: '1rem', padding: '0.9rem 1rem', borderRadius: 8,
        border: `1px solid ${theme.accent}44`, background: `${theme.accent}08`
      }}>
        <label htmlFor="mrt-profile-description" style={{ display: 'block', fontWeight: 700, color: theme.accent, fontSize: '0.9rem', marginBottom: '0.4rem' }}>
          Describe it in your own words (optional)
        </label>
        <p style={{ margin: '0 0 0.6rem', fontSize: '0.82rem', color: theme.textDim, lineHeight: 1.5 }}>
          e.g. <em>"My mom has LADA and she takes insulin twice per day"</em> — we pick up the condition,
          medicines, age, and who you're researching for.
        </p>
        <textarea
          id="mrt-profile-description"
          value={describeText}
          onChange={e => setDescribeText(e.target.value)}
          placeholder="My mom has LADA and takes insulin twice a day…"
          rows={3}
          style={{ ...inputStyle, width: '100%', fontFamily: 'inherit', resize: 'vertical' }}
        />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.5rem', alignItems: 'center' }}>
          <button type="button" style={btn('primary', describeBusy || !describeText.trim())}
            disabled={describeBusy || !describeText.trim()} onClick={fillFromDescription}>
            {describeBusy ? <Loader size={14} className="spin" /> : null}
            {describeBusy ? ' Reading…' : ' Fill profile from this'}
          </button>
          {PROFILE_DESCRIBE_EXAMPLES.map((ex, i) => (
            <button key={i} type="button" style={{ ...btn('ghost'), fontSize: '0.75rem' }}
              onClick={() => setDescribeText(ex)}>
              {ex.length > 42 ? ex.slice(0, 39) + '…' : ex}
            </button>
          ))}
        </div>
        {describeNote && (
          <p role="status" aria-live="polite" style={{
            margin: '0.6rem 0 0', fontSize: '0.82rem', lineHeight: 1.5,
            color: describeNote.startsWith('Filled') ? theme.green : theme.textDim
          }}>{describeNote}</p>
        )}
        {(patient.condition || patient.caregiverContext || patient.medications) && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginTop: '0.65rem' }}>
            {patient.caregiverContext && (
              <span style={{ padding: '0.15rem 0.5rem', borderRadius: 999, fontSize: '0.72rem',
                background: `${theme.secondary}18`, color: theme.secondary, border: `1px solid ${theme.secondary}44` }}>
                {patient.caregiverContext}
              </span>
            )}
            {patient.condition && (
              <span style={{ padding: '0.15rem 0.5rem', borderRadius: 999, fontSize: '0.72rem',
                background: `${theme.accent}18`, color: theme.accent, border: `1px solid ${theme.accent}44` }}>
                {patient.condition}
              </span>
            )}
            {patient.medications && (
              <span style={{ padding: '0.15rem 0.5rem', borderRadius: 999, fontSize: '0.72rem',
                background: `${theme.green}18`, color: theme.green, border: `1px solid ${theme.green}44` }}>
                Meds on file
              </span>
            )}
          </div>
        )}
      </div>

      <div style={{
        marginBottom: '1rem', padding: '0.85rem 0.95rem', borderRadius: 8,
        border: `1px solid ${theme.accent}44`, background: `${theme.accent}0c`
      }}>
        <div style={{ fontWeight: 700, color: theme.text, fontSize: '0.88rem', marginBottom: '0.35rem' }}>
          Where your information is kept
        </div>
        <p style={{ margin: 0, fontSize: '0.82rem', color: theme.textDim, lineHeight: 1.55 }}>
          We <strong style={{ color: theme.text }}>do not store your profile on our servers</strong>.
          To create your report, the text you submit is sent to AI providers (Anthropic and Perplexity).
          Please don&apos;t enter anything that could identify a real person.{' '}
          <button type="button" onClick={openTerms} style={{
            background: 'transparent', border: 'none', color: theme.accent,
            cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit', fontSize: '0.82rem', padding: 0
          }}>Terms of Use</button>
        </p>
      </div>
      {!privatePreviewUnlimited && <div style={{
        marginBottom: '1rem',
        padding: '0.8rem 0.9rem',
        borderRadius: 8,
        border: `1px solid ${theme.border}`,
        background: theme.panel
      }}>
        <div style={{ fontSize: '0.9rem', fontWeight: 700, color: theme.text, marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          Pricing & monthly limits
          {(usageInfo?.usage?.plan === 'dev' || usageInfo?.usage?.unlimited || usageInfo?.devUnlimited || runtimeConfig?.monetization?.devUnlimited) && (
            <span style={{
              fontSize: '0.68rem', fontWeight: 600, letterSpacing: '0.02em',
              padding: '0.2rem 0.45rem', borderRadius: 4,
              background: `${theme.green}18`, border: `1px solid ${theme.green}44`, color: theme.green
            }}>
              {(typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname))
                ? 'Local development — usage limits disabled'
                : 'Private preview — unlimited runs'}
            </span>
          )}
        </div>
        <div className="mrt-table-scroll" tabIndex="0" aria-label="Pricing table, scroll horizontally if needed">
        <table style={{ width: '100%', fontSize: '0.82rem', borderCollapse: 'collapse', marginBottom: '0.65rem' }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${theme.border}`, color: theme.textDim, textAlign: 'left' }}>
              <th style={{ padding: '0.35rem 0.5rem' }}>Plan</th>
              <th style={{ padding: '0.35rem 0.5rem' }}>Price</th>
              <th style={{ padding: '0.35rem 0.5rem' }}>Runs / month</th>
            </tr>
          </thead>
          <tbody>
            {tiers.map((t) => (
              <tr key={t.id} style={{ borderBottom: `1px solid ${theme.border}44` }}>
                <td style={{ padding: '0.35rem 0.5rem', fontWeight: 600, color: theme.text }}>{t.label}</td>
                <td style={{ padding: '0.35rem 0.5rem', color: theme.textDim }}>{fmtTierPrice(t)}</td>
                <td style={{ padding: '0.35rem 0.5rem', color: theme.textDim }}>{t.runsPerMonth}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        {usageInfo?.usage && (
          <div style={{ fontSize: '0.8rem', color: theme.accent, marginBottom: '0.5rem', fontWeight: 600 }}>
            {(usageInfo.usage.plan === 'dev' || usageInfo.usage.unlimited)
              ? ((typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname))
                ? 'Local development — unlimited runs.'
                : 'Unlimited runs on this plan.')
              : `Current usage: ${usageInfo.usage.used}/${usageInfo.usage.limit} this month (${usageInfo.usage.plan} plan).`}
          </div>
        )}
        {!upgradeUrl && (
          <div style={{ fontSize: '0.78rem', color: theme.textDim, marginBottom: '0.5rem', lineHeight: 1.5 }}>
            Contact support if you need a Pro or Max activation code.
          </div>
        )}
        <div style={{ display: 'flex', gap: '0.45rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {upgradeUrl && (
            <a href={upgradeUrl} target="_blank" rel="noopener noreferrer"
              style={{ ...btn('ghost', false), textDecoration: 'none' }}>
              Upgrade online
            </a>
          )}
          <label htmlFor="mrt-upgrade-code" className="mrt-sr-only">Pro or Max activation code</label>
          <input
            id="mrt-upgrade-code"
            value={upgradeCode}
            onChange={e => setUpgradeCode(e.target.value)}
            placeholder="Enter a Pro or Max activation code"
            style={{ ...inputStyle, width: 180, padding: '0.45rem 0.55rem', fontSize: '0.8rem' }}
          />
          <button onClick={activatePaidPlan} disabled={upgradeBusy || !upgradeCode.trim()}
            style={btn('primary', upgradeBusy || !upgradeCode.trim())}>
            {upgradeBusy ? <><Loader size={14} className="spin" /> Activating…</> : 'Activate code'}
          </button>
        </div>
      </div>}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center',
        padding: '0.6rem 0.8rem', background: `${theme.accent}0e`,
        border: `1px dashed ${theme.accent}55`, borderRadius: 8,
        marginBottom: '1rem'
      }}>
        <span style={{ fontSize: '0.78rem', color: theme.textDim, fontWeight: 600, letterSpacing: 0.3 }}>
          Demo profiles (fictional):
        </span>
        {Object.entries(SAMPLE_PATIENTS).map(([key, s]) => (
          <button key={key} onClick={() => loadSample(key)} style={{
            background: key === 'empty' ? 'transparent' : `${theme.accent}18`,
            border: `1px solid ${key === 'empty' ? theme.border : theme.accent + '55'}`,
            color: key === 'empty' ? theme.textDim : theme.accent,
            padding: '0.35rem 0.8rem', borderRadius: 6, fontSize: '0.78rem',
            cursor: 'pointer', fontWeight: 600,
            display: 'inline-flex', alignItems: 'center', gap: '0.35rem'
          }}>
            <span>{s.icon}</span>{s.label}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: theme.textDim, fontStyle: 'italic' }}>
          These are made-up examples, not real patients. Do not enter real personal health details.
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem' }}>
        {fields.map(f => (
          <div key={f.k} style={{ display: 'flex', flexDirection: 'column' }}>
            <label htmlFor={`mrt-profile-${f.k}`} style={labelStyle}>{f.l}</label>
            {f.ta ? (
              <textarea id={`mrt-profile-${f.k}`} value={patient[f.k] || ''} placeholder={f.ph || ''}
                onChange={e => set(f.k, e.target.value)}
                style={{ ...inputStyle, minHeight: 90, resize: 'vertical' }} />
            ) : f.type === 'select' ? (
              <select id={`mrt-profile-${f.k}`} value={patient[f.k] || ''}
                onChange={e => set(f.k, e.target.value)} style={inputStyle}>
                {f.options.map(o => (
                  <option key={o.value} value={o.value} style={{ background: theme.panelSolid, color: theme.text }}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : f.subtypePicker ? (
              <div style={{ position: 'relative' }}>
                <input id={`mrt-profile-${f.k}`} type="text" value={patient[f.k] || ''} placeholder={f.ph || ''}
                  onChange={e => set(f.k, e.target.value)}
                  onKeyDown={e => { if (f.enterSubmits && e.key === 'Enter' && !busy) { e.preventDefault(); startResearch(); } }}
                  style={inputStyle} />
                {subtypeListing && (
                  <div style={{
                    position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 30,
                    maxHeight: 280, overflowY: 'auto', borderRadius: 8,
                    border: `1px solid ${theme.accent}55`, background: theme.panelSolid,
                    boxShadow: '0 8px 24px rgba(0,0,0,0.35)'
                  }}>
                    <div style={{
                      padding: '0.45rem 0.65rem', fontSize: '0.72rem', color: theme.textDim,
                      borderBottom: `1px solid ${theme.border}`, lineHeight: 1.45
                    }}>
                      Optional — pick your gene/subtype if you know it
                      ({subtypeListing.total} known forms of {subtypeListing.parent}).
                      Skip this if you are not sure; we still run the report.
                    </div>
                    {subtypeListing.general && (
                      <button type="button" onClick={() => pickConditionSubtype(subtypeListing.general)}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left', padding: '0.55rem 0.65rem',
                          background: 'transparent', border: 'none', borderBottom: `1px solid ${theme.border}44`,
                          color: theme.text, cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.84rem'
                        }}>
                        {subtypeListing.general.label}
                      </button>
                    )}
                    {subtypeListing.subtypes.map((s) => (
                      <button key={s.id} type="button" onClick={() => pickConditionSubtype(s)}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left', padding: '0.5rem 0.65rem',
                          background: 'transparent', border: 'none', borderBottom: `1px solid ${theme.border}22`,
                          color: theme.text, cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.82rem'
                        }}>
                        <span style={{ fontWeight: 600 }}>{s.label}</span>
                        {s.gene && (
                          <span style={{ marginLeft: '0.35rem', fontSize: '0.72rem', color: theme.accent }}>
                            {s.gene}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <input id={`mrt-profile-${f.k}`} type={f.type || 'text'} value={patient[f.k] || ''} placeholder={f.ph || ''}
                onChange={e => set(f.k, e.target.value)}
                onKeyDown={e => { if (f.enterSubmits && e.key === 'Enter' && !busy) { e.preventDefault(); startResearch(); } }}
                style={inputStyle} />
            )}
          </div>
        ))}
      </div>
      {safetyFields.length > 0 && (
        <details style={{
          marginTop: '1rem', padding: '0.8rem 0.9rem', borderRadius: 8,
          border: `1px solid ${theme.border}`, background: `${theme.panel}99`
        }}>
          <summary style={{ cursor: 'pointer', fontWeight: 700, color: theme.text }}>
            Additional medicine-safety details (optional)
          </summary>
          <p style={{ margin: '0.55rem 0 0.8rem', color: theme.textDim, fontSize: '0.8rem', lineHeight: 1.5 }}>
            These are not separate research topics. Add them only if they are relevant to checking medicine safety or dosing.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem' }}>
            {safetyFields.map(f => (
              <div key={f.k} style={{ display: 'flex', flexDirection: 'column' }}>
                <label htmlFor={`mrt-profile-${f.k}`} style={labelStyle}>{f.l}</label>
                {f.ta ? (
                  <textarea id={`mrt-profile-${f.k}`} value={patient[f.k] || ''} placeholder={f.ph || ''}
                    onChange={e => set(f.k, e.target.value)}
                    style={{ ...inputStyle, minHeight: 90, resize: 'vertical' }} />
                ) : (
                  <input id={`mrt-profile-${f.k}`} value={patient[f.k] || ''} placeholder={f.ph || ''}
                    onChange={e => set(f.k, e.target.value)} style={inputStyle} />
                )}
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Primary action: explicit submit so users aren't left wondering
          how to kick off research after filling the form. Scrolling
          target so the button is always visible at the bottom. */}
      <div style={{
        marginTop: '1.5rem', display: 'flex', gap: '0.75rem',
        flexWrap: 'wrap', alignItems: 'center',
        padding: '1rem', borderRadius: 10,
        background: `linear-gradient(135deg, ${theme.accent}14 0%, rgba(110,231,183,0.08) 100%)`,
        border: `1px solid ${theme.accent}44`
      }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: '0.95rem', fontWeight: 700, color: theme.text, marginBottom: 2 }}>
            Ready when you are
          </div>
          <div style={{ fontSize: '0.82rem', color: theme.textDim }}>
            We'll find current clinical trials and trusted research (studies checked by other experts), and put together a summary for{' '}
            <strong style={{ color: theme.accent }}>
              {patient.condition?.trim() || '(enter a condition above)'}
            </strong>.
          </div>
        </div>
        <button onClick={() => { setTab && setTab('research'); }} style={btn('ghost', !!busy)} disabled={!!busy}>
          <Brain size={15} /> Go to Research
        </button>
        <button onClick={startResearch} disabled={!!busy || !patient.condition?.trim()}
          style={{ ...btn('primary', !!busy || !patient.condition?.trim()), padding: '0.8rem 1.25rem', fontSize: '0.95rem' }}>
          {busy === 'research'
            ? <><Loader size={16} className="spin" /> Researching…</>
            : <><Search size={16} /> Save &amp; Run Full Research</>}
        </button>
      </div>

      <AlertsSubscribeCard patient={patient} />
      <HipaaProfileReminder acceptedHipaa={acceptedHipaa} setAcceptedHipaa={setAcceptedHipaa} />
    </div>
  );
};

/* ==================== Weekly email alerts subscribe card ==================== */
// Subscribes the user to a Monday-morning digest for the current
// condition. Shows active subscriptions under the same email so the
// user can one-click unsubscribe from any of them.
const AlertsSubscribeCard = ({ patient }) => {
  const [email, setEmail] = useState(() => {
    try { return localStorage.getItem('mra-alerts-email') || ''; } catch { return ''; }
  });
  const [status, setStatus] = useState(null); // { kind, msg }
  const [busy, setBusy] = useState(false);
  const [subs, setSubs] = useState([]);
  const [loadedFor, setLoadedFor] = useState('');
  const [unsubscribeFor, setUnsubscribeFor] = useState(null);
  const [unsubscribeToken, setUnsubscribeToken] = useState('');

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const readOwnerTokens = (e) => {
    try {
      const all = JSON.parse(localStorage.getItem('mra-alerts-owner-tokens') || '{}');
      return Array.isArray(all[String(e || '').trim().toLowerCase()])
        ? all[String(e || '').trim().toLowerCase()]
        : [];
    } catch { return []; }
  };
  const writeOwnerTokens = (e, entries) => {
    try {
      const all = JSON.parse(localStorage.getItem('mra-alerts-owner-tokens') || '{}');
      all[String(e || '').trim().toLowerCase()] = entries.slice(0, 20);
      localStorage.setItem('mra-alerts-owner-tokens', JSON.stringify(all));
    } catch {}
  };

  const loadSubs = async (e = email) => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) { setSubs([]); setLoadedFor(''); return; }
    try {
      const owned = readOwnerTokens(e);
      const responses = await Promise.all(owned.map(async ({ token }) => {
        const r = await fetch(`/api/alerts-subscribe?email=${encodeURIComponent(e)}&token=${encodeURIComponent(token)}`);
        return r.ok ? (await r.json()).subscriptions || [] : [];
      }));
      const byId = new Map(responses.flat().map((sub) => [sub.id, sub]));
      setSubs([...byId.values()]);
      setLoadedFor(e);
    } catch (err) { /* silent */ }
  };

  useEffect(() => {
    if (emailValid && email !== loadedFor) loadSubs(email);
  }, [email]);

  const subscribe = async () => {
    if (!emailValid) { setStatus({ kind: 'error', msg: 'Please enter a valid email.' }); return; }
    if (!patient.condition) { setStatus({ kind: 'error', msg: 'Enter a primary condition above first.' }); return; }
    setBusy(true); setStatus(null);
    try {
      localStorage.setItem('mra-alerts-email', email);
      const r = await fetch('/api/alerts-subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email, condition: patient.condition,
          patientContext: {
            age: patient.age, gender: patient.gender, stage: patient.stage,
            diagnoses: patient.diagnoses, medications: patient.medications,
            allergies: patient.allergies
          }
        })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Subscription failed');
      if (d.ownerToken && d.id) {
        const owned = readOwnerTokens(email).filter((entry) => entry.id !== d.id);
        writeOwnerTokens(email, [...owned, { id: d.id, token: d.ownerToken }]);
      }
      if (d.alreadyExists) {
        setStatus({ kind: 'info', msg: `You're already signed up for weekly ${patient.condition} updates.` });
      } else {
        setStatus({
          kind: 'ok',
          msg: d.ephemeral
            ? `Subscribed — but the server's storage is not set up yet, so this won't be saved in production. Ask the admin to finish setup.`
            : `Subscribed! Your first update arrives Monday morning (UTC 14:00).`
        });
      }
      await loadSubs(email);
    } catch (err) {
      setStatus({ kind: 'error', msg: err.message });
    } finally {
      setBusy(false);
    }
  };

  const unsubscribe = async (sub, suppliedToken = '') => {
    const savedToken = readOwnerTokens(email).find((entry) => entry.id === sub.id)?.token || '';
    const token = String(suppliedToken || savedToken).trim();
    if (!token) {
      setUnsubscribeFor(sub);
      setUnsubscribeToken('');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/alerts-subscribe?action=unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: sub.id, token })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Unsubscribe failed');
      writeOwnerTokens(email, readOwnerTokens(email).filter((entry) => entry.id !== sub.id));
      setStatus({ kind: 'ok', msg: `Unsubscribed from ${sub.condition}.` });
      setUnsubscribeFor(null);
      setUnsubscribeToken('');
      await loadSubs(email);
    } catch (err) {
      setStatus({ kind: 'error', msg: err.message });
    } finally {
      setBusy(false);
    }
  };

  const exportSubscriptionData = async (sub) => {
    const token = readOwnerTokens(email).find((entry) => entry.id === sub.id)?.token || '';
    if (!token) {
      setStatus({ kind: 'error', msg: 'The private management link for this subscription is not stored in this browser.' });
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(`/api/alerts-subscribe?action=export&id=${encodeURIComponent(sub.id)}&token=${encodeURIComponent(token)}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Export failed');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `alert-subscription-${sub.id}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setStatus({ kind: 'ok', msg: `Exported the stored data for ${sub.condition}.` });
    } catch (err) {
      setStatus({ kind: 'error', msg: err.message });
    } finally {
      setBusy(false);
    }
  };

  const statusColor =
    status?.kind === 'ok'   ? theme.green :
    status?.kind === 'info' ? theme.accent :
    status?.kind === 'error'? theme.red   : theme.textDim;

  return (
    <div style={{
      marginTop: '1.25rem', padding: '1rem', borderRadius: 8,
      background: `${theme.accent}10`, border: `1px solid ${theme.accent}40`
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Mail size={16} color={theme.accent} />
          <strong style={{ color: theme.accent }}>Weekly research update (beta)</strong>
        </div>
        <span style={{ fontSize: '0.7rem', color: theme.textDim }}>Monday 9am CT · free · unsubscribe anytime</span>
      </div>
      <p style={{ margin: '0.5rem 0 0.75rem', fontSize: '0.85rem', color: theme.textDim, lineHeight: 1.5 }}>
        Every Monday we search again for{' '}
        <strong style={{ color: theme.text }}>{patient.condition || '(no condition set above)'}</strong>,
        compare what we find with what you've already seen, and email you only what is new —
        the strongest new studies first, then other research that experts have checked, new clinical trials,
        and any FDA news. We leave out papers that were pulled back (retracted) or come from sources known for
        quality problems, just like the website does.
      </p>
      <p style={{
        margin: '0 0 0.75rem', padding: '0.55rem 0.65rem', borderRadius: 6,
        fontSize: '0.78rem', color: theme.textDim, lineHeight: 1.5,
        background: theme.panel, border: `1px solid ${theme.border}`
      }}>
        Email alerts store your <strong style={{ color: theme.text }}>email, condition, and the limited health details you submit</strong> in
        a secure database when available and use an email delivery service. Subscriptions expire after at most 365 days unless renewed.
        You can download or delete a subscription from this browser. Do not include information that identifies you directly.
      </p>
      <form onSubmit={(event) => { event.preventDefault(); subscribe(); }} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <label htmlFor="mrt-alert-email" className="mrt-sr-only">Email address for weekly updates</label>
        <input
          id="mrt-alert-email"
          type="email" value={email} placeholder="you@example.com"
          onChange={(e) => setEmail(e.target.value)}
          style={{ ...inputStyle, flex: '1 1 260px', maxWidth: 360 }}
        />
        <button
          type="submit"
          disabled={busy || !emailValid || !patient.condition}
          style={{
            padding: '0.55rem 1.1rem', borderRadius: 8, border: 'none',
            background: (busy || !emailValid || !patient.condition) ? theme.textDim : theme.accent,
            color: '#fff', fontWeight: 700, cursor: (busy || !emailValid || !patient.condition) ? 'not-allowed' : 'pointer',
            fontSize: '0.88rem', display: 'flex', alignItems: 'center', gap: '0.4rem'
          }}>
          <Mail size={14} /> {busy ? 'Subscribing…' : 'Subscribe'}
        </button>
      </form>
      {status && (
        <div role={status.kind === 'error' ? 'alert' : 'status'} aria-live="polite" style={{ marginTop: '0.6rem', fontSize: '0.82rem', color: statusColor }}>
          {status.msg}
        </div>
      )}
      {subs.length > 0 && (
        <div style={{ marginTop: '0.85rem', paddingTop: '0.75rem', borderTop: `1px solid ${theme.border}` }}>
          <div style={{ fontSize: '0.75rem', color: theme.textDim, fontWeight: 600, marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: 0.3 }}>
            Your active subscriptions
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
            {subs.map((s) => (
              <div key={s.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '0.4rem 0.6rem', background: theme.panel,
                borderRadius: 6, fontSize: '0.82rem'
              }}>
                <span>
                  <strong>{s.condition}</strong>
                  <span style={{ color: theme.textDim, marginLeft: '0.5rem' }}>
                    · {s.cadence} · last run: {s.lastRunAt ? new Date(s.lastRunAt).toLocaleDateString() : 'pending first run'}
                  </span>
                </span>
                <span style={{ display: 'flex', gap: '0.35rem' }}>
                  <button type="button" disabled={busy} onClick={() => exportSubscriptionData(s)} style={{
                    background: 'transparent', border: `1px solid ${theme.accent}66`,
                    color: theme.accent, padding: '0.2rem 0.6rem', borderRadius: 4,
                    fontSize: '0.72rem', cursor: 'pointer'
                  }}>
                    Export data
                  </button>
                  <button type="button" disabled={busy} onClick={() => unsubscribe(s)} style={{
                    background: 'transparent', border: `1px solid ${theme.red}66`,
                    color: theme.red, padding: '0.2rem 0.6rem', borderRadius: 4,
                    fontSize: '0.72rem', cursor: 'pointer'
                  }}>
                    Delete
                  </button>
                </span>
              </div>
            ))}
          </div>
          {unsubscribeFor && (
            <form onSubmit={(event) => {
              event.preventDefault();
              unsubscribe(unsubscribeFor, unsubscribeToken);
            }} style={{ marginTop: '0.7rem', padding: '0.7rem', border: `1px solid ${theme.yellow}55`, borderRadius: 7 }}>
              <label htmlFor="mrt-unsubscribe-code" style={labelStyle}>
                Unsubscribe code for {unsubscribeFor.condition}
              </label>
              <p style={{ margin: '0.2rem 0 0.5rem', color: theme.textDim, fontSize: '0.78rem' }}>
                Paste the code from your welcome email or any update email.
              </p>
              <div style={{ display: 'flex', gap: '0.45rem', flexWrap: 'wrap' }}>
                <input id="mrt-unsubscribe-code" value={unsubscribeToken}
                  onChange={(event) => setUnsubscribeToken(event.target.value)}
                  autoComplete="off" style={{ ...inputStyle, flex: '1 1 220px' }} />
                <button type="submit" disabled={busy || !unsubscribeToken.trim()} style={btn('primary', busy || !unsubscribeToken.trim())}>
                  {busy ? 'Unsubscribing…' : 'Confirm unsubscribe'}
                </button>
                <button type="button" onClick={() => { setUnsubscribeFor(null); setUnsubscribeToken(''); }} style={btn('ghost')}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
};

/* ==================== Access-level badge ==================== */
// Visually encodes what Claude actually read for each source:
//   full-text     → green  — body of article (from PMC or legal OA)
//   abstract      → blue   — peer-reviewed abstract
//   metadata-only → orange — title + journal only; no content
const ACCESS_META = {
  'full-text':     { label: 'Full text',     color: '#6ee7b7', desc: 'We read the whole article' },
  'abstract':      { label: 'Summary only', color: '#60a5fa', desc: 'We read only the short summary, so claims are limited to what the summary says' },
  'metadata-only': { label: 'No text',       color: '#fbbf24', desc: 'The paper exists, but we could not read the full article or the summary — so the AI cannot say what it found' }
};
const AccessBadge = ({ level, n }) => {
  const m = ACCESS_META[level] || { label: level, color: theme.textDim, desc: '' };
  return (
    <span title={m.desc} style={{
      display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
      padding: '0.25rem 0.6rem', borderRadius: 999, fontSize: '0.75rem',
      border: `1px solid ${m.color}66`, background: `${m.color}18`,
      color: m.color, fontWeight: 600
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: '50%', background: m.color,
        display: 'inline-block'
      }} />
      {m.label}{typeof n === 'number' ? ` · ${n}` : ''}
    </span>
  );
};

/* ==================== Reusable meter + evidence badge ==================== */
// Visual meter bar used for Efficacy / Safety / Confidence on the
// repurposing candidate cards. Renders a gradient-filled horizontal bar
// with the percentage in-line and a color that matches ratingColor().
// MeterBar — a labelled progress bar with a numeric % readout. The
// optional `note` prop is the one-line plain-English justification
// for that specific number, rendered immediately below the bar so
// the user always sees WHY a score is what it is (Dorothy: "for
// those percentage things we do need a bit of a justification").
// The note is also surfaced as a tooltip on the % so power users
// who collapse the prose can still hover.
const MeterBar = ({ label, value, band, icon, note }) => {
  // Band mode (Safety/Confidence, evidence-backed): show Low/Moderate/High
  // with the gradient bucketed to three levels. Legacy % mode is kept for
  // any older cached report that still carries a numeric value.
  const isBand = !!band;
  const color = isBand ? bandColor(band) : ratingColor(value);
  const pct = isBand
    ? bandFillPct(band)
    : (typeof value === 'number' ? Math.max(0, Math.min(100, value)) : 0);
  const readout = isBand ? band : (typeof value === 'number' ? `${pct}%` : '—');
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <div style={{ width: 92, fontSize: '0.72rem', color: theme.textDim, fontWeight: 600, letterSpacing: 0.3, textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
          {icon}{label}
        </div>
        <div style={{
          flex: 1, height: 8, borderRadius: 999, background: theme.panel,
          overflow: 'hidden', position: 'relative'
        }}>
          <div style={{
            width: `${pct}%`, height: '100%',
            background: `linear-gradient(90deg, ${color}77, ${color})`,
            transition: 'width 0.5s ease'
          }} />
        </div>
        <div
          title={note || ''}
          style={{ width: isBand ? 74 : 46, textAlign: 'right', fontSize: isBand ? '0.78rem' : '0.85rem', fontWeight: 700, color, fontVariantNumeric: 'tabular-nums', cursor: note ? 'help' : 'default' }}
        >
          {readout}
        </div>
      </div>
      {note && (
        <div style={{
          marginLeft: 102, // align under the bar, past the label column
          marginTop: 3,
          fontSize: '0.72rem',
          color: theme.textDim,
          lineHeight: 1.45,
          fontStyle: 'italic'
        }}>
          <InlineMD text={note} />
        </div>
      )}
    </div>
  );
};

// OutcomeRow retained unused — "How well it works" efficacy display was
// removed from cards (dead/mismatched source links). Do not reintroduce.
const OutcomeRow = ({ label, icon, text }) => {
  if (!text) return null;
  return null;
};

// Evidence strength ladder. Matches the EVIDENCE_STRENGTH enum Claude
// is asked to emit (MECHANISTIC_ONLY → LARGE_RCT). Color scales from
// red (pure hypothesis) to bright green (RCT data).
const EVIDENCE_LADDER = [
  { key: 'MECHANISTIC_ONLY', label: 'Theory based on biology',   color: '#ef4444', rank: 1 },
  { key: 'PRECLINICAL',      label: 'Lab or animal research',    color: '#f97316', rank: 2 },
  { key: 'CASE_REPORT',      label: 'Case report',               color: '#eab308', rank: 3 },
  { key: 'OBSERVATIONAL',    label: 'Human observational study', color: '#a3e635', rank: 4 },
  { key: 'SMALL_RCT',        label: 'Small randomized controlled trial', color: '#22c55e', rank: 5 },
  { key: 'LARGE_RCT',        label: 'Large randomized controlled trial', color: '#10b981', rank: 6 }
];
const evidenceMeta = (value) => {
  const v = String(value || '').toUpperCase().trim();
  const hit = EVIDENCE_LADDER.find(e => v.includes(e.key));
  return hit || { key: 'UNSPECIFIED', label: value || 'Unspecified', color: theme.textDim, rank: 0 };
};
// Plain-English "what has this actually been tested in?" — so a reader
// instantly sees that e.g. goji berry for RP has animal evidence but no
// human trials, instead of having to decode the "Preclinical" tier.
const evidenceTestedIn = (value, lay = true) => {
  const m = evidenceMeta(value);
  switch (m.key) {
    // These describe what THIS SEARCH found, never what exists in the world.
    // The lay string used to assert "not yet tested in humans or animals for
    // this condition", which put a flat falsehood on the most-studied
    // repurposing candidates a condition has: exenatide (Lancet Phase 2 and a
    // completed Phase 3 in Parkinson disease), nilotinib (NILO-PD), ambroxol,
    // nicotine and caffeine all landed in this bucket declaring they had never
    // been tested in PD. A card that says "we did not find one" can only ever
    // be wrong about our coverage; one that says "none exists" is wrong about
    // medicine, and a reader could reasonably drop a real option over it.
    case 'MECHANISTIC_ONLY':
      return lay ? 'No study in this condition was found in this search — the reasoning is biological'
                 : 'Mechanistic rationale only — no condition-specific study identified in this search';
    case 'PRECLINICAL':
      return lay ? 'Lab or animal studies found in this search — no human study for this condition was found'
                 : 'Laboratory or animal research — no human study for this condition identified in this search';
    case 'CASE_REPORT':
      return lay ? 'Reported in a small number of human cases — no formal trial found in this search'
                 : 'Human case report(s) only';
    case 'OBSERVATIONAL':
      return lay ? 'Seen in human observational studies (not a controlled trial)'
                 : 'Human observational data';
    case 'SMALL_RCT':
      return lay ? 'Tested in a small human clinical trial' : 'Small randomized controlled trial';
    case 'LARGE_RCT':
      return lay ? 'Tested in large human clinical trials' : 'Large randomized controlled trial';
    default:
      return '';
  }
};
const EvidenceStrengthBadge = ({ value }) => {
  const m = evidenceMeta(value);
  const isHypothesisOnly = m.key === 'MECHANISTIC_ONLY';
  return (
    <span title={`Evidence strength: ${isHypothesisOnly ? 'Hypothesis only — no condition-specific study found in this search' : m.label} (rank ${m.rank}/6)`} style={{
      display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
      padding: '0.25rem 0.65rem', borderRadius: 999, fontSize: '0.72rem',
      border: isHypothesisOnly ? `2px dashed ${m.color}` : `1px solid ${m.color}88`,
      background: isHypothesisOnly ? `${m.color}12` : `${m.color}1f`,
      color: m.color, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase'
    }}>
      {!isHypothesisOnly && (
        <span style={{ display: 'inline-flex', gap: 1.5 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <span key={i} style={{
              width: 4, height: 8, borderRadius: 1,
              background: i < m.rank ? m.color : `${m.color}33`
            }} />
          ))}
        </span>
      )}
      {isHypothesisOnly ? 'Hypothesis only' : m.label}
    </span>
  );
};

/* ==================== Curated Knowledge Base ==================== */
// When the condition matches a hand-curated KB (e.g. IPF), these items
// are PINNED into the evidence pack on every query — the ground-truth
// floor that never changes with a new PubMed search.
const KBBadge = ({ category }) => (
  <span title={`A trusted, hand-picked key source we always include${category ? ` (${category})` : ''}`} style={{
    display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
    padding: '0.25rem 0.6rem', borderRadius: 999, fontSize: '0.75rem',
    border: `1px solid ${theme.accent}66`,
    background: `${theme.accent}22`,
    color: theme.accent, fontWeight: 700, letterSpacing: 0.3
  }}>
    <Award size={11} /> KEY SOURCE{category ? ` · ${String(category).toUpperCase()}` : ''}
  </span>
);

/* Markdown renderer for AI analysis output.
   The Claude responses are markdown (headings, tables, **bold**,
   bullet lists, [links](url)). Rendering them as plain pre-wrapped
   text shows raw asterisks and pipe characters, which the user
   specifically complained about. `marked` is loaded from CDN in
   <head>; we memoise the parse per-text so re-renders are cheap.
   Links get target=_blank and the mrt-markdown class carries all
   the typography styles. */
const escapeHtml = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// AI/model Markdown is untrusted. marked deliberately permits raw HTML,
// so every rendered fragment must cross this strict DOM allowlist before
// it reaches dangerouslySetInnerHTML or an export clone.
const sanitizeRenderedHtml = (html, allowedUrls = new Set()) => {
  return sanitizeReportHtml(html, allowedUrls, {
    DOMParserImpl: typeof DOMParser === 'undefined' ? null : DOMParser,
    baseUrl: typeof window === 'undefined' ? 'https://invalid.local' : window.location.origin
  });
};

const Markdown = ({ text, allowedUrls }) => {
  const html = useMemo(() => {
    if (!text) return '';
    let linked = linkifyMedicalIds(publicTextOrFallback(text));
    linked = sanitizeMarkdownLinks(linked, allowedUrls);
    if (typeof window === 'undefined' || !window.marked) {
      return escapeHtml(linked)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br/>');
    }
    window.marked.setOptions({ gfm: true, breaks: false });
    const renderer = new window.marked.Renderer();
    const origLink = renderer.link.bind(renderer);
    renderer.link = (href, title, label) => {
      // The model is told to emit a Google-search fallback link for
      // centers/orgs (api/research.js). Relabel the bare "Google search"
      // anchor text to a clean "Search ↗" so it never leaks as visible
      // prose; keep entity-name labels intact.
      let displayLabel = label;
      const plain = String(label || '').replace(/<[^>]+>/g, '').trim();
      if (isGoogleSearchUrl(href) && (!plain || /^google\s*search$/i.test(plain))) {
        displayLabel = 'Search ↗';
      }
      const out = origLink(href, title, displayLabel);
      // In-page anchor jumps (e.g. the Section 4 "jump to trials" link)
      // must scroll within the page, NOT open a new tab.
      if (/^#/.test(String(href || ''))) return out;
      return out.replace('<a ', '<a target="_blank" rel="noopener noreferrer" ');
    };
    // Models sometimes wrap NOT-approved flags in ~~strikethrough~~ — show plain text.
    renderer.del = (text) => text;
    return sanitizeRenderedHtml(window.marked.parse(String(linked), { renderer }), allowedUrls);
  }, [text, allowedUrls]);
  return <div className="mrt-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
};

// Render a card TITLE inline. The model sometimes wraps headings in
// markdown bold/italic and even link syntax, e.g.
//   "**Quetiapine (Seroquel XR)**"
//   "**Taurine + Lurasidone (Latuda)**"
//   "**[Lumateperone (Caplyta)](https://…)**"
// Those render literally in a plain {text} node. Strip the bold/italic
// markers and turn any [label](url) into a real anchor so titles show
// clean text (and links are clickable, never raw "[text](url)").
const InlineTitle = ({ text, allowedUrls = new Set() }) => {
  const raw = String(text == null ? '' : text);
  const stripBold = (s) => s.replace(/\*\*|__|\*|_/g, '');
  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  const nodes = [];
  let last = 0, m, key = 0;
  while ((m = linkRe.exec(raw)) !== null) {
    if (m.index > last) {
      const lead = stripBold(raw.slice(last, m.index));
      if (lead) nodes.push(lead);
    }
    const safeUrl = allowedReportUrl(m[2], allowedUrls);
    nodes.push(safeUrl
      ? <a key={`l${key++}`} href={safeUrl} target="_blank" rel="noopener noreferrer"
          style={{ color: theme.accent, textDecoration: 'underline' }}>{stripBold(m[1])}</a>
      : <React.Fragment key={`t${key++}`}>{stripBold(m[1])}</React.Fragment>);
    last = linkRe.lastIndex;
  }
  if (last < raw.length) {
    const tail = stripBold(raw.slice(last));
    if (tail) nodes.push(tail);
  }
  return <React.Fragment>{nodes}</React.Fragment>;
};

// Inline-safe markdown for SHORT card fields (meter notes, risks line,
// rationale, "what it does", patient-specific risks, etc.). Converts
//   **bold** / __bold__         → <strong>
//   [label](url)                → real clickable link (new tab)
// and renders everything else as plain text. Unlike <Markdown> it injects
// NO block wrappers (<p>/<div>), so it is safe inside tiny one-line rows
// where a block renderer would break the layout. The model emits literal
// `**bold**` and `[label](url)` in these fields; rendered as a bare
// {field} text node they showed as raw characters (the defect this fixes).
// Always render the SCRUBBED value (callers pass auditAndScrubCard output).
const InlineMD = ({ text, allowedUrls = new Set() }) => {
  // Strip DailyMed SEARCH links (not citations) to plain text before
  // rendering any card field inline (references, risks, rationale, …).
  const raw = stripDailyMedSearchLinks(String(text == null ? '' : text));
  if (!raw) return null;
  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  const renderBold = (s, keyBase) => {
    const out = [];
    const boldRe = /\*\*([^*]+)\*\*|__([^_]+)__/g;
    let last = 0, m, i = 0;
    while ((m = boldRe.exec(s)) !== null) {
      if (m.index > last) out.push(s.slice(last, m.index));
      out.push(<strong key={`${keyBase}b${i++}`}>{m[1] || m[2]}</strong>);
      last = boldRe.lastIndex;
    }
    if (last < s.length) out.push(s.slice(last));
    return out;
  };
  const nodes = [];
  let last = 0, m, key = 0;
  while ((m = linkRe.exec(raw)) !== null) {
    if (m.index > last) nodes.push(...renderBold(raw.slice(last, m.index), `t${key}`));
    const safeUrl = allowedReportUrl(m[2], allowedUrls);
    nodes.push(safeUrl
      ? <a key={`l${key++}`} href={safeUrl} target="_blank" rel="noopener noreferrer"
          style={{ color: theme.accent, textDecoration: 'underline' }}>{cleanAnchorLabel(m[1], safeUrl)}</a>
      : <React.Fragment key={`t${key++}`}>{cleanAnchorLabel(m[1], m[2])}</React.Fragment>);
    last = linkRe.lastIndex;
  }
  if (last < raw.length) nodes.push(...renderBold(raw.slice(last), `t${key}`));
  return <React.Fragment>{nodes}</React.Fragment>;
};

// Non-blocking indicator shown on a card whose field(s) failed to parse
// (the leak detector found residual structural tokens). Shows a small
// a friendly formatting note instead of rendering leaked parser content.
const FormatWarning = ({ leaks }) => {
  if (!leaks || !leaks.length) return null;
  return (
    <div style={{
      marginTop: '0.5rem', padding: '0.45rem 0.6rem', borderRadius: 8,
      border: `1px dashed ${theme.yellow}88`, background: `${theme.yellow}12`,
      fontSize: '0.78rem', color: theme.yellow, lineHeight: 1.45
    }}>
      <span style={{ fontWeight: 700 }}>Part of this card could not be displayed</span>
      {' '}because its formatting was incomplete. Check the linked source or try the report again.
    </div>
  );
};

const SourceLinks = ({ text, label = 'Sources', allowedUrls = new Set() }) => {
  const links = useMemo(
    () => filterAllowedReportLinks(extractLinksFromText(text), allowedUrls),
    [text, allowedUrls]
  );
  if (!links.length) return null;
  return (
    <div style={{ marginTop: '0.5rem' }}>
      <div style={{ fontSize: '0.72rem', fontWeight: 700, color: theme.textDim, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
        {links.map((l, i) => (
          <a key={i} href={l.url} target="_blank" rel="noopener noreferrer"
            style={{ fontSize: '0.78rem', color: theme.accent, wordBreak: 'break-all' }}>
            {linkLabelText(l.label)} ↗
          </a>
        ))}
      </div>
    </div>
  );
};

/* ==================== Word / PDF Export ====================
   Dorothy priority: a clean Word (.doc) download with real headings,
   bold labels, clickable links, and a light readable page — NOT a
   DOM dump and NOT PDF-first. PDF remains a secondary print path.

   Shared helpers below feed both Word (HTML-as-.doc Blob) and the
   optional browser print / Save-as-PDF path. */

// Render markdown (or already-linkified plain text) to HTML with every
// link forced to open in a new tab. Used to upgrade any pre-wrap text
// block that contains bare URLs / PMIDs / NCT IDs into real anchors.
const renderMarkdownForExport = (text, allowedUrls = null) => {
  // Never carry a DailyMed SEARCH / Google / PubMed-search link into an export.
  const source = allowedUrls
    ? sanitizeMarkdownLinks(stripDailyMedSearchLinks(text || ''), allowedUrls)
    : stripDailyMedSearchLinks(text || '');
  let linked = linkifyMedicalIds(source);
  linked = String(linked)
    .replace(/\[([^\]]+)\]\(https?:\/\/(?:www\.)?google\.[a-z.]+\/search[^)]*\)/gi, '$1')
    .replace(/\[([^\]]+)\]\(https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/\?term=[^)]*\)/gi, '$1')
    .replace(/\[([^\]]+)\]\(https?:\/\/(?:www\.)?clinicaltrials\.gov\/search[^)]*\)/gi, '$1');
  if (typeof window !== 'undefined' && window.marked) {
    window.marked.setOptions({ gfm: true, breaks: false });
    const renderer = new window.marked.Renderer();
    const origLink = renderer.link.bind(renderer);
    renderer.link = (href, title, lbl) => {
      const h = String(href || '');
      if (/google\.[a-z.]+\/search|dailymed\.nlm\.nih\.gov\/dailymed\/search\.cfm|pubmed\.ncbi\.nlm\.nih\.gov\/\?term=|clinicaltrials\.gov\/search/i.test(h)) {
        return String(lbl || '');
      }
      return origLink(href, title, lbl).replace('<a ', '<a target="_blank" rel="noopener noreferrer" ');
    };
    return sanitizeRenderedHtml(window.marked.parse(String(linked), { renderer }), allowedUrls || new Set());
  }
  return escapeHtml(linked).replace(/\n/g, '<br/>');
};

// Walk a cloned export tree and guarantee every reference is a real,
// clickable anchor. Markdown blocks already carry <a> tags; whiteSpace
// pre-wrap blocks (chat, fixed-field cards) may have bare IDs — we
// re-render those through marked so the PDF/Word output is clickable.
const linkifyExportClone = (root) => {
  if (!root) return;
  root.querySelectorAll('.mrt-markdown').forEach((block) => {
    block.querySelectorAll('a').forEach((a) => {
      a.setAttribute('target', '_blank');
      a.style.color = '#0563C1';
      a.style.textDecoration = 'underline';
    });
    const plain = block.textContent || '';
    if (!block.querySelector('a') && /https?:\/\/|PMID|NCT\d{8}|10\.\d{4,}/i.test(plain)) {
      block.innerHTML = renderMarkdownForExport(plain);
    }
  });
  // Any element NOT inside a markdown block but still holding bare
  // medical IDs in its raw text (e.g. pre-wrap card fields) gets
  // linkified in place so nothing ships as dead text.
  root.querySelectorAll('a').forEach((a) => {
    a.setAttribute('target', '_blank');
    if (!a.style.color) a.style.color = '#0563C1';
    a.style.textDecoration = 'underline';
  });
};

const exportBtnStyle = (busy, disabled) => ({
  background: (busy || disabled) ? theme.panel : `${theme.accent}18`,
  border: `1px solid ${(busy || disabled) ? theme.border : theme.accent}`,
  color: (busy || disabled) ? theme.textDim : theme.accent,
  padding: '0.45rem 0.85rem', borderRadius: 6, fontSize: '0.82rem',
  fontWeight: 700,
  cursor: (busy || disabled) ? 'not-allowed' : 'pointer',
  display: 'inline-flex', alignItems: 'center', gap: '0.4rem'
});

// Shared stylesheet for Word (.doc) and optional PDF print. Light page,
// clear heading hierarchy, bold labels — Word-friendly semantic HTML.
const EXPORT_PRINT_CSS = `
  @page { margin: 18mm 16mm; }
  * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #ffffff; }
  body {
    font-family: "Calibri", "Segoe UI", Georgia, "Times New Roman", serif;
    color: #1a1a1a; font-size: 12pt; line-height: 1.55;
  }
  .mrt-export-wrap { padding: 8px 4px 28px; max-width: 7.5in; margin: 0 auto; }
  .mrt-export-root { color: #1a1a1a; }
  .mrt-export-root p { margin: 0 0 10px; }
  .mrt-export-root a { color: #0563C1 !important; text-decoration: underline !important; word-break: break-word; }
  .mrt-export-root h1 {
    color: #0b3d57 !important; font-size: 22pt; font-weight: 700;
    line-height: 1.25; margin: 0 0 12px; border-bottom: 2px solid #0b3d57; padding-bottom: 8px;
  }
  .mrt-export-root h2 {
    color: #0b3d57 !important; font-size: 15pt; font-weight: 700;
    line-height: 1.3; margin: 22px 0 10px; border-bottom: 1px solid #cfd8dc; padding-bottom: 4px;
  }
  .mrt-export-root h3 {
    color: #123a4f !important; font-size: 12.5pt; font-weight: 700;
    line-height: 1.35; margin: 16px 0 6px;
  }
  .mrt-export-root h4 { color: #1a1a1a !important; font-size: 11.5pt; font-weight: 700; margin: 10px 0 4px; }
  .mrt-export-root ul, .mrt-export-root ol { margin: 6px 0 12px; padding-left: 22px; }
  .mrt-export-root li { margin: 0 0 4px; }
  .mrt-export-root strong, .mrt-export-root b { font-weight: 700; color: #111827; }
  .mrt-export-root table { border-collapse: collapse; width: 100%; margin: 10px 0 14px; font-size: 11pt; }
  .mrt-export-root th, .mrt-export-root td { border: 1px solid #cfd8dc; padding: 6px 8px; text-align: left; vertical-align: top; }
  .mrt-export-root th { background: #eef3f6 !important; font-weight: 700; color: #0b3d57 !important; }
  .mrt-export-root img { max-width: 100%; }
  .mrt-export-root pre, .mrt-export-root code { white-space: pre-wrap; word-break: break-word; font-size: 10.5pt; }
  .mrt-export-card {
    margin: 0 0 14px; padding: 10px 12px; border: 1px solid #dbe3e8;
    border-radius: 4px; background: #fafcfd;
  }
  .mrt-export-label { font-weight: 700; color: #0b3d57; }
  .mrt-export-meta { font-size: 11pt; color: #374151; margin: 0 0 12px; }
  .mrt-export-root h2, .mrt-export-root h3, .mrt-export-root table,
  .mrt-export-root li, .mrt-export-root p, .mrt-export-card { page-break-inside: avoid; }
  .mrt-export-disclaimer {
    margin: 0 0 16px; padding: 10px 12px; border: 1px solid #e5e7eb;
    border-left: 4px solid #b45309; border-radius: 4px;
    background: #fffbeb !important; font-size: 10.5pt; color: #374151 !important; line-height: 1.45;
  }
  .mrt-export-foot {
    margin-top: 22px; padding-top: 10px; border-top: 1px solid #e5e7eb;
    font-size: 9.5pt; color: #6b7280 !important;
  }
`;

// Build the standalone HTML document we feed to the print iframe.
const buildExportDocument = ({ bodyHtml, title, verification }) => {
  const stamp = new Date().toLocaleString();
  bodyHtml = publicTextOrFallback(bodyHtml);
  title = publicTextOrFallback(title, 'Medical research report');
  const verificationMeta = verification
    ? `<meta name="mrt-report-verification" content="${escapeHtmlForExport(verification)}">`
    : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `${verificationMeta}<title>${escapeHtmlForExport(title)}</title><style>${EXPORT_PRINT_CSS}</style></head>` +
    `<body><div class="mrt-export-wrap">` +
    `<div class="mrt-export-disclaimer">${MEDICAL_DISCLAIMER}</div>` +
    `<div class="mrt-export-root">${bodyHtml}</div>` +
    `<div class="mrt-export-foot">Generated ${stamp} · Links in this document are clickable.</div>` +
    `</div></body></html>`;
};

// Print a built HTML document through a hidden iframe. Using an iframe
// (rather than window.open) sidesteps popup blockers and keeps the
// browser's "Save as PDF" path, which preserves clickable links.
const printExportDocument = (html) => new Promise((resolve, reject) => {
  try {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    Object.assign(iframe.style, {
      position: 'fixed', right: '0', bottom: '0',
      width: '0', height: '0', border: '0', visibility: 'hidden'
    });
    document.body.appendChild(iframe);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try { document.body.removeChild(iframe); } catch {}
      resolve();
    };
    iframe.onload = () => {
      const win = iframe.contentWindow;
      if (!win) { cleanup(); return; }
      win.onafterprint = () => setTimeout(cleanup, 300);
      setTimeout(() => {
        try { win.focus(); win.print(); }
        catch (e) { console.error('[pdf] print failed', e); cleanup(); }
      }, 300);
      // Safety net: tear the iframe down even if afterprint never fires
      // (some browsers don't emit it for the Save-as-PDF destination).
      setTimeout(cleanup, 60000);
    };
    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(html);
    doc.close();
  } catch (err) {
    reject(err);
  }
});

const reportContractHtml = (contract) =>
  `<div class="mrt-export-disclaimer"><strong>${escapeHtmlForExport(contract.label)}</strong>` +
  (contract.coverageMessages?.length
    ? `<br/>What may be missing: ${escapeHtmlForExport(contract.coverageMessages.join(' '))}`
    : '') +
  '</div>';

const PdfExportButton = ({ getElement, filename, label, disabled, getCompletionContract, surface = 'research' }) => {
  const [busy, setBusy] = useState(false);
  const onClick = async () => {
    if (busy || disabled) return;
    const el = typeof getElement === 'function' ? getElement() : null;
    if (!el) { notifyUser('Nothing to export yet — run the analysis first.', 'error'); return; }
    setBusy(true);
    try {
      const contract = await getCompletionContract(surface);
      const title = (filename || 'medical-research-analysis.pdf').replace(/\.pdf$/i, '');
      const html = buildExportDocument({
        bodyHtml: reportContractHtml(contract) +
          renderMarkdownForExport(contract.canonicalContent),
        title,
        verification: contract.seal
      });
      await printExportDocument(html);
      notifyUser('Print dialog opened. Choose “Save as PDF” to finish the export.', 'success');
    } catch (err) {
      console.error('[pdf] export failed', err);
      notifyUser('PDF export failed: ' + (err?.message || err), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      onClick={onClick}
      disabled={busy || disabled}
      title="Save as a PDF with clickable links. Opens your browser's print dialog — choose 'Save as PDF' as the destination."
      style={exportBtnStyle(busy, disabled)}
    >
      <Download size={14} /> {busy ? 'Preparing PDF…' : (label || 'Export PDF')}
    </button>
  );
};

const downloadWordDocument = ({ html, filename }) => {
  const blob = new Blob(['\ufeff', html], { type: 'application/msword;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'medical-research-analysis.doc';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

const WordExportButton = ({ getElement, filename, label, disabled, getCompletionContract, surface = 'research' }) => {
  const [busy, setBusy] = useState(false);
  const onClick = async () => {
    if (busy || disabled) return;
    const el = typeof getElement === 'function' ? getElement() : null;
    if (!el) { notifyUser('Nothing to export yet — run the analysis first.', 'error'); return; }
    setBusy(true);
    try {
      const contract = await getCompletionContract(surface);
      const title = (filename || 'medical-research-analysis.doc').replace(/\.docx?$/i, '');
      const html = buildExportDocument({
        bodyHtml: reportContractHtml(contract) +
          renderMarkdownForExport(contract.canonicalContent),
        title,
        verification: contract.seal
      });
      downloadWordDocument({ html, filename: filename || `${title}.doc` });
      notifyUser('Word download started.', 'success');
    } catch (err) {
      console.error('[word] export failed', err);
      notifyUser('Word export failed: ' + (err?.message || err), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      onClick={onClick}
      disabled={busy || disabled}
      title="Download as a Word document with headings, bold labels, and clickable links"
      style={exportBtnStyle(busy, disabled)}
    >
      <FileText size={14} /> {busy ? 'Generating Word…' : (label || 'Export Word')}
    </button>
  );
};

const AnalysisExportBar = ({ getElement, exportBaseFilename, disabled, text, getCompletionContract }) => {
  const base = exportBaseFilename || 'analysis';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap',
      padding: '0.45rem 0.65rem', borderRadius: 8,
      background: `${theme.accent}10`, border: `1px solid ${theme.accent}44`
    }} data-pdf-exclude="1">
      <span style={{ fontSize: '0.72rem', fontWeight: 700, color: theme.textDim, letterSpacing: 0.3 }}>
        Export
      </span>
      <WordExportButton getElement={getElement} filename={`${base}.doc`} label="Export Word" disabled={disabled} getCompletionContract={getCompletionContract} />
      <PdfExportButton getElement={getElement} filename={`${base}.pdf`} label="PDF" disabled={disabled} getCompletionContract={getCompletionContract} />
      <TextExportButton text={text} filename={`${base}.txt`} label="Text" disabled={disabled || !text} getCompletionContract={getCompletionContract} />
    </div>
  );
};

const TextExportButton = ({ text, filename, label, disabled, getCompletionContract, surface = 'research' }) => {
  const onClick = async () => {
    if (disabled || !text) return;
    try {
      const contract = await getCompletionContract(surface);
      // Convert to readable text. Shipping the raw markdown meant a downloaded
      // report carried "|---|---|" separator rows, "[label](url)" syntax and
      // "##" markers — and the text file is the one most likely to be pasted
      // into an email or handed to a clinician.
      const payload = publicTextOrFallback(`${contract.label}` +
        (contract.coverageMessages?.length ? `\nWhat may be missing: ${contract.coverageMessages.join(' ')}` : '') +
        `\n\n${MEDICAL_DISCLAIMER}\n\n${markdownToPlainText(contract.canonicalContent)}`);
      const blob = new Blob([payload], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || 'medical-research-analysis.txt';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      notifyUser('Text download started.', 'success');
    } catch (err) {
      notifyUser(err?.message || 'Text export is not available.', 'error');
    }
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled || !text}
      title="Download this analysis as a text file"
      style={{
        background: 'transparent',
        border: `1px solid ${theme.border}`,
        color: (disabled || !text) ? theme.textDim : theme.accent,
        padding: '0.3rem 0.7rem', borderRadius: 6, fontSize: '0.75rem',
        cursor: (disabled || !text) ? 'not-allowed' : 'pointer',
        display: 'inline-flex', alignItems: 'center', gap: '0.35rem'
      }}
    >
      <FileText size={13} /> {label || 'Download Text'}
    </button>
  );
};

const escapeHtmlForExport = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Every screen/export representation is derived from the same canonical model.
const buildFullReportBody = ({ reportModel }) => {
  const {
    patient = {},
    patientFields = [],
    sections: {
      researchText = '',
      treatments = [],
      candidates = [],
      combos = [],
      trialsData = {},
      trialsText = '',
      references = [],
      evidenceSummary = null,
      evidencePack = []
    } = {}
  } = reportModel || {};
  const parts = [];
  const cond = patient?.condition || 'your condition';
  const allowedUrls = buildAllowedUrlSet(trialsData, evidenceSummary || { topRanked: evidencePack || [] });
  const field = (label, value) => {
    if (!value) return '';
    const body = typeof value === 'string' && /[*_\[`]|https?:\/\//.test(value)
      ? renderMarkdownForExport(value, allowedUrls)
      : `<p>${escapeHtmlForExport(value)}</p>`;
    return `<p><span class="mrt-export-label">${escapeHtmlForExport(label)}:</span> ${
      body.replace(/^<p>/, '').replace(/<\/p>$/, '')
    }</p>`;
  };
  const cardBlock = (inner) => `<div class="mrt-export-card">${inner}</div>`;

  parts.push(`<h1>Full Research Report — ${escapeHtmlForExport(cond)}</h1>`);
  const bio = [];
  if (patient?.age) bio.push(`Age ${escapeHtmlForExport(patient.age)}`);
  if (patient?.gender || patient?.sex) bio.push(escapeHtmlForExport(patient.gender || patient.sex));
  if (patient?.stage) bio.push(`Stage/severity: ${escapeHtmlForExport(patient.stage)}`);
  if (bio.length) {
    parts.push(`<p class="mrt-export-meta"><strong>Patient profile:</strong> ${bio.join(' · ')}</p>`);
  }
  const profileDetails = [
    ['Weight', patient?.weight],
    ['Smoking history', patient?.smoking],
    ['Activity', patient?.exercise],
    ['Current diagnoses', patient?.diagnoses],
    ['Current medicines and supplements', patient?.medications],
    ['Prior treatments', patient?.medicationHistory],
    ['Allergies', patient?.allergies],
    ['Current symptoms', patient?.symptoms],
    ['Lab and test results', patient?.labWork],
    ['Recent imaging', patient?.scans],
    ['Pregnancy/breastfeeding status', patient?.pregnancyStatus],
    ['Kidney/renal function', patient?.renalFunction],
    ['Liver/hepatic function', patient?.hepaticFunction],
    ['Gene test result', patient?.geneticVariant],
    ['Caregiver context', patient?.caregiverContext]
  ].filter(([, value]) => String(value || '').trim());
  if (profileDetails.length) {
    parts.push('<h2>Patient Context Used for This Report</h2>');
    profileDetails.forEach(([label, value]) => parts.push(field(label, value)));
  }
  const omitted = (Array.isArray(patientFields) ? patientFields : [])
    .filter((item) => item && typeof item === 'object')
    .filter((item) => item.included && !item.value)
    .map((item) => item.label);
  if (omitted.length) {
    parts.push(`<p class="mrt-export-meta"><strong>Profile fields not included because no value was provided:</strong> ${omitted.map(escapeHtmlForExport).join(', ')}.</p>`);
  }
  parts.push('<p class="mrt-export-meta">Educational research summary for discussion with a licensed clinician. Every source link below is clickable.</p>');

  const realTx = (treatments || []).filter((t) => t.treatment && !t._approvedStub);
  const stubTx = (treatments || []).filter((t) => t.treatment && t._approvedStub);
  if (realTx.length || stubTx.length) {
    parts.push(`<h2>FDA-Approved Treatments for ${escapeHtmlForExport(cond)}</h2>`);
    realTx.forEach((t, i) => {
      parts.push(`<h3>${i + 1}. ${escapeHtmlForExport(String(t.treatment).replace(/[*_]/g, ''))}</h3>`);
      let body = '';
      if (t.fda_status) body += field('FDA status', t.fda_status);
      if (t.provider) body += field('What it is / how it works', t.provider);
      if (t.length_frequency) body += field('Dose and schedule', t.length_frequency);
      if (t.efficacy) body += field('What studies found', t.efficacy);
      if (t.safety_band || t.safety_note || t.safety) {
        body += field('Safety concern', [t.safety_band, t.safety_note || t.safety].filter(Boolean).join(' — '));
      }
      if (t.risks) body += field('Risks', t.risks);
      if (t.interactions) body += field('Medication interactions', t.interactions);
      if (t.references) body += field('Sources', t.references);
      parts.push(cardBlock(body || '<p>See linked sources in the research report.</p>'));
    });
    if (stubTx.length) {
      parts.push('<h3>Other FDA-approved treatments with verified labels</h3><ul>');
      stubTx.forEach((t) => {
        parts.push(`<li><strong>${escapeHtmlForExport(String(t.treatment).replace(/[*_]/g, ''))}</strong>` +
          (t.provider ? ` — ${escapeHtmlForExport(String(t.provider).replace(/^Mechanism:\s*/i, ''))}` : '') +
          '</li>');
      });
      parts.push('</ul>');
    }
  }

  if (researchText) {
    parts.push('<h2>Detailed Condition Report</h2>');
    parts.push(renderMarkdownForExport(
      polishReportForDisplay(stripForeignDiseaseContamination(researchText, cond)),
      allowedUrls
    ));
  }

  const studies = normalizeTrialStudies(trialsData?.studies);
  const trialCoverage = trialCoverageMessage(trialsData);
  if (studies.length || trialCoverage) {
    const trialHeading = trialsData?.savedDemo
      ? 'Saved demo — not live trial list'
      : 'Clinical Trials';
    parts.push(`<h2>${trialHeading} (${studies.length})</h2>`);
    parts.push(`<p>${escapeHtmlForExport(trialCollectionDescription(trialsData))}</p>`);
    if (trialCoverage) {
      parts.push(`<p><strong>Incomplete trial coverage:</strong> ${escapeHtmlForExport(trialCoverage)}</p>`);
    }
    if (studies.length) {
      const headers = ['Study', 'Study stage', 'Study status', 'Accepting inquiries', 'Eligibility review', 'Placebo listed', 'Access notes', 'Countries', 'Monitoring', 'Why this order', 'Open link'];
      parts.push(`<table><caption>First ${Math.min(TRIAL_ROW_DISPLAY_LIMIT, studies.length)} clinical trial records shown in the report</caption><thead><tr>${headers.map((header) => `<th scope="col">${header}</th>`).join('')}</tr></thead><tbody>`);
      studies.slice(0, TRIAL_ROW_DISPLAY_LIMIT).forEach((s) => {
        const assessment = s.eligibilityAssessment;
        const eligibilityLabel = {
          unknown: 'Eligibility unknown',
          'hard-mismatch': 'Likely not eligible based on provided facts',
          'criteria-unavailable': 'Criteria unavailable',
          'criteria-unchecked': 'Eligibility not fully checked'
        }[assessment?.status] || 'Eligibility not assessed';
        const unknownFacts = [...new Set(
          (assessment?.checks || [])
            .filter((check) => check?.status === 'unknown')
            .map((check) => check.reason)
            .filter(Boolean)
        )];
        const eligibility = [eligibilityLabel, ...(unknownFacts.length
          ? unknownFacts
          : [assessment?.caution || 'Patient-specific facts needed to determine eligibility were not provided.'])]
          .join(' — ');
        const accessNotes = [
          s.designations?.hasOpenLabelExtension ? 'Open-label extension' : '',
          s.isExpandedAccessStudy ? 'Expanded Access' : '',
          s.designations?.hasPostTrialAccess ? 'Post-trial access noted' : '',
          s.designations?.hasPayToAccess ? 'You may have to pay' : ''
        ].filter(Boolean).join('; ') || '—';
        const monitoring = [
          s.oversight?.oversightHasDMC ? 'Independent safety monitoring' : '',
          s.oversight?.fdaRegulatedDrug ? 'FDA-regulated drug' : ''
        ].filter(Boolean).join('; ') || '—';
        const studySummary = [
          s.briefTitle || s.title || s.nctId || 'Study',
          s.nctId,
          s.sponsor,
          s.relevanceLabel ? `Match: ${s.relevanceLabel}` : '',
          s.stoppedNegative && s.caution ? `Stopped / negative: ${s.caution}` : ''
        ].filter(Boolean).join(' — ');
        const why = trialOrderingBreakdown(s).map((item) => `${item.label}: ${item.why}`).join('; ') || 'No ranking details listed.';
        const url = exactClinicalTrialUrl(s);
        const link = url
          ? `<a href="${escapeHtmlForExport(url)}">${escapeHtmlForExport(s.nctId || 'View study')}</a>`
          : '—';
        const cells = [
          studySummary,
          (s.phases || []).map(humanizeRegistryValue).join(', ') || 'Not listed',
          humanizeRegistryValue(s.overallStatus || s.status) || 'Not listed',
          trialBooleanLabel(s.acceptingNewPatients, { unknown: 'Unknown' }),
          eligibility,
          trialBooleanLabel(s.hasPlacebo, { unknown: 'Not listed' }),
          accessNotes,
          (s.countries || []).join(', ') || '—',
          monitoring,
          why
        ].map((value) => `<td>${escapeHtmlForExport(value)}</td>`).join('');
        parts.push(`<tr>${cells}<td>${link}</td></tr>`);
      });
      parts.push('</tbody></table>');
    }
  }
  if (trialsText) {
    parts.push('<h2>Patient-Specific Trial Review</h2>');
    parts.push(renderMarkdownForExport(trialsText, allowedUrls));
  }

  const { neverResearched, researchedNotApproved, evidenceStatusUnknown } =
    partitionCandidates(candidates || [], patient?.condition || '');
  if (neverResearched.length || researchedNotApproved.length || evidenceStatusUnknown.length) {
    parts.push(`<h2>Treatment and supportive-care research ideas (${neverResearched.length + researchedNotApproved.length + evidenceStatusUnknown.length})</h2>`);
    parts.push(`<p class="mrt-export-meta">Grouped by whether this search identified condition-specific research. These are discussion topics, not benefit or eligibility predictions.</p>`);
  }

  if (neverResearched.length) {
    parts.push(`<h2>No Condition-Specific Study Identified in This Search (${neverResearched.length})</h2>`);
    parts.push(`<p>The indirect rationale comes from other conditions or biological research and does not imply benefit.</p>`);
    neverResearched.forEach((c, i) => {
      const name = escapeHtmlForExport(String(c.candidate || 'Idea').replace(/[*_]/g, ''));
      const resolvedKind = resolveItemKind(c);
      const kind = resolvedKind === 'SUPPORTIVE_CARE' ? 'Supportive / non-drug care' : resolvedKind === 'SUPPLEMENT' ? 'Supplement' : 'Medication';
      parts.push(`<h3>${i + 1}. ${name} <span style="font-weight:600;font-size:10pt;color:#555;">(${kind})</span></h3>`);
      let body = `<p><em>No condition-specific study identified in this search. This does not imply benefit.</em></p>`;
      if (c.what_it_does) body += field('What it is', c.what_it_does);
      if (c.why_for_this_condition || c.repurpose_rationale) {
        body += field('Why this option was searched', c.why_for_this_condition || c.repurpose_rationale);
      }
      if (c.approved_for) body += field('Usually used for', c.approved_for);
      if (c.efficacy_hypothesis) body += field('Expected benefit', c.efficacy_hypothesis);
      if (c.safety) body += field('Safety concern', c.safety);
      if (c.patient_specific_risks) body += field('Risks for this patient', c.patient_specific_risks);
      if (c.how_to_discuss_with_doctor) body += field('Questions for your doctor', c.how_to_discuss_with_doctor);
      if (c.references || c.supporting_evidence) {
        body += field('Sources', c.references || c.supporting_evidence);
      }
      parts.push(cardBlock(body));
    });
  }

  if (researchedNotApproved.length) {
    parts.push(`<h2>Researched, Not Yet FDA-Approved for ${escapeHtmlForExport(cond)} (${researchedNotApproved.length})</h2>`);
    parts.push(`<p>These have been researched for ${escapeHtmlForExport(cond)} but are not FDA-approved for it. Already-approved treatments appear only under FDA-Approved Treatments.</p>`);
    researchedNotApproved.forEach((c, i) => {
      const name = escapeHtmlForExport(String(c.candidate || 'Idea').replace(/[*_]/g, ''));
      const resolvedKind = resolveItemKind(c);
      const kind = resolvedKind === 'SUPPORTIVE_CARE' ? 'Supportive / non-drug care' : resolvedKind === 'SUPPLEMENT' ? 'Supplement' : 'Medication';
      parts.push(`<h3>${i + 1}. ${name} <span style="font-weight:600;font-size:10pt;color:#555;">(${kind})</span></h3>`);
      let body = '';
      if (c.what_it_does) body += field('What it is', c.what_it_does);
      if (c.why_for_this_condition || c.repurpose_rationale) {
        body += field('Why this option was searched', c.why_for_this_condition || c.repurpose_rationale);
      }
      if (c.supporting_evidence) body += field('What the research says', c.supporting_evidence);
      if (c.efficacy_hypothesis) body += field('Expected benefit', c.efficacy_hypothesis);
      if (c.safety) body += field('Safety concern', c.safety);
      if (c.patient_specific_risks) body += field('Risks for this patient', c.patient_specific_risks);
      if (c.how_to_discuss_with_doctor) body += field('Questions for your doctor', c.how_to_discuss_with_doctor);
      if (c.references) body += field('Sources', c.references);
      parts.push(cardBlock(body || '<p>See linked sources.</p>'));
    });
  }

  if (evidenceStatusUnknown.length) {
    parts.push(`<h2>Condition-Specific Study Status Unclear (${evidenceStatusUnknown.length})</h2>`);
    parts.push('<p>The available information did not establish whether condition-specific research exists. Verify before relying on these items.</p>');
    evidenceStatusUnknown.forEach((c, i) => {
      parts.push(`<h3>${i + 1}. ${escapeHtmlForExport(String(c.candidate || 'Idea').replace(/[*_]/g, ''))}</h3>`);
      parts.push(cardBlock(field('Evidence status', 'Not established in the reviewed information.')));
    });
  }

  if ((combos || []).length) {
    parts.push(`<h2>Combinations Studied for This Condition (${combos.length})</h2>`);
    combos.forEach((c, i) => {
      parts.push(`<h3>${i + 1}. ${escapeHtmlForExport(String(c.combo || 'Combination').replace(/[*_]/g, ''))}</h3>`);
      let body = '';
      if (c.rationale) body += field('Why the combination was studied', c.rationale);
      if (c.supporting_evidence) body += field('Evidence', c.supporting_evidence);
      if (c.interaction_risk || c.patient_specific_risks) {
        body += field('Safety notes', c.interaction_risk || c.patient_specific_risks);
      }
      if (c.references) body += field('Sources', c.references);
      parts.push(cardBlock(body || '<p>No evidence-supported combination was identified in this search.</p>'));
    });
  }

  if (references && references.length) {
    const items = references.filter((r) => urlIsAllowed(r.url, allowedUrls)).map((r) =>
      `<li><a href="${escapeHtmlForExport(r.url)}">${escapeHtmlForExport(r.quote || r.url)}</a></li>`
    ).join('');
    parts.push(`<h2>All References &amp; Links</h2><ol>${items}</ol>`);
  }
  return parts.join('\n');
};

const exportHtmlToPlainText = (html) => {
  const root = document.createElement('div');
  root.innerHTML = String(html || '');
  root.querySelectorAll('a[href]').forEach((anchor) => {
    const label = String(anchor.textContent || '').trim();
    const href = String(anchor.getAttribute('href') || '').trim();
    anchor.replaceWith(document.createTextNode(label && label !== href ? `${label} (${href})` : href));
  });
  root.querySelectorAll('br').forEach((node) => node.replaceWith(document.createTextNode('\n')));
  root.querySelectorAll('th,td').forEach((node) => node.appendChild(document.createTextNode('\t')));
  root.querySelectorAll('h1,h2,h3,h4,p,li,tr,caption,div').forEach((node) => {
    if (node.tagName === 'LI') node.insertBefore(document.createTextNode('• '), node.firstChild);
    node.appendChild(document.createTextNode('\n'));
  });
  return String(root.textContent || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\t+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const FullReportExportButton = (props) => {
  const [busy, setBusy] = useState(false);
  const complete = !props.appBusy;
  const base = `full-report-${(props.patient?.condition || 'analysis').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
  const exportDocument = async (format) => {
    if (busy) return;
    if (!complete) {
      notifyUser('Wait for the full report and drug-idea review to finish before exporting.', 'error');
      return;
    }
    setBusy(true);
    try {
      const contract = await props.getCompletionContract('full');
      const html = buildExportDocument({
        bodyHtml: reportContractHtml(contract) +
          renderMarkdownForExport(contract.canonicalContent),
        title: base,
        verification: contract.seal
      });
      if (format === 'pdf') {
        await printExportDocument(html);
        notifyUser('Print dialog opened. Choose “Save as PDF” to finish the export.', 'success');
      } else {
        downloadWordDocument({ html, filename: `${base}.doc` });
        notifyUser('Full report Word download started.', 'success');
      }
    } catch (err) {
      console.error(`[${format}] full report export failed`, err);
      notifyUser(`${format === 'pdf' ? 'PDF' : 'Word'} export failed: ` + (err?.message || err), 'error');
    } finally {
      setBusy(false);
    }
  };
  const fullText = exportHtmlToPlainText(buildFullReportBody({ reportModel: props.reportModel }));
  return (
    <div style={{ display: 'flex', gap: '0.45rem', flexWrap: 'wrap' }}>
      <button
        onClick={() => exportDocument('word')}
        disabled={busy || !complete}
        title="Download the complete verified report as a Word document."
        style={{
          ...exportBtnStyle(busy, !complete),
          background: (busy || !complete) ? theme.panel : theme.accent,
          color: (busy || !complete) ? theme.textDim : '#ffffff',
          borderColor: theme.accent
        }}
      >
        <FileText size={14} /> {busy ? 'Preparing…' : 'Full Report Word'}
      </button>
      <button
        onClick={() => exportDocument('pdf')}
        disabled={busy || !complete}
        title="Save the complete verified report as a PDF."
        style={exportBtnStyle(busy, !complete)}
      >
        <Download size={14} /> Full Report PDF
      </button>
      <TextExportButton
        text={fullText}
        filename={`${base}.txt`}
        label="Full Report Text"
        disabled={busy || !complete}
        getCompletionContract={props.getCompletionContract}
        surface="full"
      />
    </div>
  );
};

const AnalysisLanguageToolbar = ({
  sourceText, translatedText, setTranslatedText,
  exportElementId, exportBaseFilename, getCompletionContract
}) => {
  const [lang, setLang] = useState('English');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    // New analysis text invalidates old translations.
    setTranslatedText('');
    setLang('English');
    setError('');
  }, [sourceText]);

  const translateTo = async (targetLanguage) => {
    if (!sourceText) return;
    if (targetLanguage === 'English') {
      setTranslatedText('');
      setError('');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const d = await fetch('/api/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'translate',
          text: sourceText,
          sourceLanguage: 'English',
          targetLanguage
        })
      }).then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok) throw new Error(formatApiError(body, r));
        return body;
      });
      if (d.translationStatus !== 'validated') {
        setTranslatedText('');
        setError('A safe translation is unavailable. Showing the validated English report.');
        return;
      }
      setTranslatedText(d.translatedText || '');
      setError('');
    } catch (err) {
      setError('The translation could not be completed. The verified English report is still available.');
    } finally {
      setBusy(false);
    }
  };

  const onChangeLang = async (nextLang) => {
    setLang(nextLang);
    await translateTo(nextLang);
  };

  const exportName = `${exportBaseFilename || 'analysis'}-${lang.toLowerCase()}`;
  const displayText = translatedText || sourceText;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }} data-pdf-exclude="1">
      <div style={{
        display: 'flex', alignItems: 'center', gap: '0.35rem',
        background: theme.panel, border: `1px solid ${theme.border}`,
        borderRadius: 6, padding: '0.2rem 0.45rem'
      }}>
        <Languages size={13} color={theme.textDim} />
        <select
          aria-label="Report and export language"
          value={lang}
          onChange={e => onChangeLang(e.target.value)}
          disabled={!sourceText || busy}
          style={{
            background: 'transparent', color: theme.text, border: 'none',
            outline: 'none', fontFamily: 'inherit', fontSize: '0.75rem', cursor: 'pointer'
          }}
          title="Translate this analysis on-demand"
        >
          {TRANSLATION_LANGS.map((l) => (
            <option key={l} value={l} style={{ background: theme.panelSolid, color: theme.text }}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <WordExportButton
        getElement={() => document.getElementById(exportElementId)}
        filename={`${exportName}.doc`}
        label="Export Word"
        disabled={!displayText}
        getCompletionContract={getCompletionContract}
      />
      <TextExportButton
        text={displayText}
        filename={`${exportName}.txt`}
        label="Export Text"
        disabled={!displayText}
        getCompletionContract={getCompletionContract}
      />
      <PdfExportButton
        getElement={() => document.getElementById(exportElementId)}
        filename={`${exportName}.pdf`}
        label="Export PDF"
        disabled={!displayText}
        getCompletionContract={getCompletionContract}
      />
      {busy && <span style={{ fontSize: '0.72rem', color: theme.textDim }}>Translating…</span>}
      {error && <span style={{ fontSize: '0.72rem', color: theme.red }}>{error}</span>}
      {!busy && !error && (
        <span style={{ fontSize: '0.68rem', color: theme.textDim }}>
          Exports include a medical disclaimer.
        </span>
      )}
    </div>
  );
};

const AdSlot = ({ runtimeConfig, slotKey, minHeight = 90 }) => {
  const ads = runtimeConfig?.ads;
  if (!ads?.enabled) return null;
  const slot = ads?.slots?.[slotKey] || '';
  const client = ads?.adsenseClient || '';

  useEffect(() => {
    if (!client) return;
    const scriptSrc = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${client}`;
    let script = document.querySelector(`script[src="${scriptSrc}"]`);
    if (!script) {
      script = document.createElement('script');
      script.async = true;
      script.src = scriptSrc;
      script.crossOrigin = 'anonymous';
      document.head.appendChild(script);
    }
  }, [client]);

  return (
    <div style={{
      ...panelStyle,
      padding: '0.7rem 0.8rem',
      borderStyle: 'dashed',
      minHeight
    }}>
      <div style={{ fontSize: '0.7rem', color: theme.textDim, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.35rem' }}>
        Sponsored
      </div>
      {client && slot ? (
        <ins
          className="adsbygoogle"
          style={{ display: 'block', minHeight: `${Math.max(60, minHeight - 28)}px` }}
          data-ad-client={client}
          data-ad-slot={slot}
          data-ad-format="auto"
          data-full-width-responsive="true"
          ref={(el) => {
            if (!el) return;
            try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (_) {}
          }}
        />
      ) : (
        <div style={{ fontSize: '0.82rem', color: theme.textDim }}>
          Ads are enabled, but this slot is not configured yet.
        </div>
      )}
    </div>
  );
};

/* ==================== Repurpose Explainer ====================
   Dorothy's exact words: "when they click on 'repurpose' have an
   explanation: Sometimes drugs already exist which may help a
   condition but because they are generic there may not be much
   money in researching them. This uses AI to determine what drug
   may appear to be successful that already exists."
   Plain-English explainer on Research above the two drug-idea lists,
   collapsed by default so it doesn't clutter the page. */
const RepurposeExplainer = () => {
  const [open, setOpen] = useState(false);
  return (
    <div style={{
      ...panelStyle,
      padding: '0.85rem 1rem',
      borderLeft: `3px solid ${theme.accent}`,
      background: `linear-gradient(90deg, ${theme.accent}10 0%, ${panelStyle.background} 60%)`
    }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: '0.5rem',
          width: '100%', background: 'transparent', border: 'none',
          color: theme.text, cursor: 'pointer', textAlign: 'left', padding: 0
        }}
      >
        <Info size={16} color={theme.accent} />
        <span style={{ fontSize: '0.92rem', fontWeight: 600, flex: 1 }}>
          How are these drug and supplement ideas found?
        </span>
        <span style={{ fontSize: '0.75rem', color: theme.textDim }}>
          {open ? '▲ Hide' : '▼ Show'}
        </span>
      </button>
      {open && (
        <div style={{ marginTop: '0.75rem', color: theme.textDim, fontSize: '0.88rem', lineHeight: 1.6 }}>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: theme.text }}>The short version:</strong>{' '}
            Sometimes a drug that already exists — one that has been used safely for years for
            a different illness — may also help with <em>your</em> condition. But many of
            these drugs are <strong>generic</strong> (cheap, with no patent). That means a
            drug company can't make much money from them, so no one pays for the costly
            studies needed to get the FDA to add a new use to the label. The drug may work;
            nobody is paying to prove it.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: theme.text }}>What this tool does:</strong>{' '}
            It asks an AI that has read a huge number of medical papers a simple question:
            <em> based on what we know about your condition, and on how each FDA-approved drug
            works in the body, which existing drugs might help?</em> The AI lists ideas,
            rates how strong the proof is for each one (from "just an idea" up to "tested in a
            large study"), and warns you about any drug interactions with the medicines you
            already take.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: theme.text }}>What this tool is NOT:</strong>{' '}
            It is <strong>not a prescription</strong> and <strong>not a recommendation</strong>.
            It gives you ideas so you can have a smarter talk with your doctor. For each idea,
            we show how strong the proof is, where it came from, and what to say at your
            appointment.
          </p>
          <p style={{ margin: 0, fontSize: '0.82rem', color: theme.textDim, fontStyle: 'italic' }}>
            This approach follows the same logic used in academic programs that systematically
            study approved drugs for possible new uses, including work by researchers like{' '}
            <a href="https://everycure.org" target="_blank" rel="noopener noreferrer" style={{ color: theme.accent }}>
              Dr. David Fajgenbaum
            </a>{' '}
            and initiatives like{' '}
            <a href="https://www.cureparkinsons.org.uk/international-linked-clinical-trials/" target="_blank" rel="noopener noreferrer" style={{ color: theme.accent }}>
              Cure Parkinson's iLCT
            </a>.
          </p>
        </div>
      )}
    </div>
  );
};

const KBPanel = ({ kb }) => {
  const [expanded, setExpanded] = useState(false);
  if (!kb || !kb.matched) return null;
  const facts = (kb.canonicalFacts || []).slice(0, expanded ? 99 : 4);
  const lifestyle = (kb.lifestyleRecommendations || []).slice(0, expanded ? 99 : 3);
  const redFlags = (kb.redFlags || []).slice(0, expanded ? 99 : 3);
  return (
    <div style={{
      ...panelStyle,
      borderLeft: `3px solid ${theme.accent}`,
      background: `linear-gradient(90deg, ${theme.accent}10 0%, ${panelStyle.background} 60%)`
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
        <h3 style={{ margin: 0, color: theme.accent, fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Award size={18} /> Trusted medical references · {kb.condition}
        </h3>
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
          <span style={{
            padding: '0.2rem 0.6rem', borderRadius: 999, fontSize: '0.7rem',
            background: `${theme.accent}22`, color: theme.accent, fontWeight: 600
          }}>
            {kb.itemCount} saved references
          </span>
          {kb.version && (
            <span style={{
              padding: '0.2rem 0.6rem', borderRadius: 999, fontSize: '0.7rem',
              background: theme.panel, color: theme.textDim
            }}>
              v{kb.version}
            </span>
          )}
          {kb.lastRefreshedAt && (
            <span style={{
              padding: '0.2rem 0.6rem', borderRadius: 999, fontSize: '0.7rem',
              background: `${theme.green}22`, color: theme.green, fontWeight: 600
            }}>
              Updated {new Date(kb.lastRefreshedAt).toLocaleDateString()}
            </span>
          )}
        </div>
      </div>
      <p style={{ color: theme.textDim, fontSize: '0.85rem', marginTop: '0.5rem' }}>
        {kb.source === 'dynamic-brain'
          ? <>Saved medical references for <strong>{kb.condition}</strong>, looked up from journals and trials. Search terms may be sent to public medical-data services and configured AI providers.</>
          : <>Trusted references for {kb.condition} — major guidelines, important studies, and FDA labels. Included on every run so your report stays accurate.</>}
      </p>
      {kb.trialHighlights?.length > 0 && (
        <div style={{ marginTop: '0.75rem' }}>
          <div style={{ fontSize: '0.8rem', fontWeight: 600, color: theme.text, marginBottom: '0.35rem' }}>
            Recruiting trials (refreshed daily from ClinicalTrials.gov)
          </div>
          <ul style={{ margin: 0, paddingLeft: '1.1rem', color: theme.textDim, fontSize: '0.85rem', lineHeight: 1.55 }}>
            {kb.trialHighlights.slice(0, expanded ? 99 : 4).map((t, i) => (
              <li key={i}>
                {exactClinicalTrialUrl(t)
                  ? <a href={exactClinicalTrialUrl(t)} target="_blank" rel="noopener noreferrer" style={{ color: theme.accent }}>{t.nctId}</a>
                  : t.nctId}
                {' — '}{t.title?.slice(0, 100)}{t.title?.length > 100 ? '…' : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      {facts.length > 0 && (
        <div style={{ marginTop: '0.75rem' }}>
          <div style={{ fontSize: '0.8rem', fontWeight: 600, color: theme.text, marginBottom: '0.35rem' }}>
            Key facts from research
          </div>
          <ul style={{ margin: 0, paddingLeft: '1.1rem', color: theme.textDim, fontSize: '0.85rem', lineHeight: 1.55 }}>
            {facts.map((f, i) => <li key={i}>{f.claim}</li>)}
          </ul>
        </div>
      )}
      {redFlags.length > 0 && (
        <div style={{ marginTop: '0.75rem' }}>
          <div style={{ fontSize: '0.8rem', fontWeight: 600, color: theme.red, marginBottom: '0.35rem' }}>
            Safety considerations reported in literature
          </div>
          <ul style={{ margin: 0, paddingLeft: '1.1rem', color: theme.textDim, fontSize: '0.85rem', lineHeight: 1.55 }}>
            {redFlags.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}
      {lifestyle.length > 0 && (
        <div style={{ marginTop: '0.75rem' }}>
          <div style={{ fontSize: '0.8rem', fontWeight: 600, color: theme.green, marginBottom: '0.35rem' }}>
            Lifestyle / non-drug guidance
          </div>
          <ul style={{ margin: 0, paddingLeft: '1.1rem', color: theme.textDim, fontSize: '0.85rem', lineHeight: 1.55 }}>
            {lifestyle.map((l, i) => <li key={i}>{l.recommendation}</li>)}
          </ul>
        </div>
      )}
      <button onClick={() => setExpanded(v => !v)} style={{
        marginTop: '0.75rem',
        background: 'transparent', border: `1px solid ${theme.accent}66`,
        color: theme.accent, padding: '0.35rem 0.8rem', borderRadius: 6,
        fontSize: '0.8rem', cursor: 'pointer', fontWeight: 600
      }}>
        {expanded ? 'Show less' : `Show all facts, safety considerations, and lifestyle guidance`}
      </button>
    </div>
  );
};

/* ==================== Source-quality flags + panel ==================== */
// Color + icon per quality-flag severity. The severity taxonomy matches
// what api/evidence.js computeQualityFlags() emits:
//   positive = evidence-strength boost (RCT, Cochrane, A+ journal, KB)
//   warning  = integrity concern (preprint, country-penalised, low-integrity)
//   critical = hard-exclusion class (retracted, integrity-flagged publisher)
const FLAG_COLORS = {
  positive: theme.green,
  warning: theme.yellow,
  critical: theme.red
};
const QualityFlagBadge = ({ flag }) => {
  const color = FLAG_COLORS[flag.severity] || theme.textDim;
  return (
    <span title={flag.label} style={{
      display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
      padding: '0.15rem 0.5rem', borderRadius: 4, fontSize: '0.68rem',
      border: `1px solid ${color}66`, background: `${color}1a`,
      color, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase',
      whiteSpace: 'nowrap'
    }}>
      {flag.label}
    </span>
  );
};

const CountryBadge = ({ country }) => {
  if (!country) return null;
  const color = theme.textDim;
  const title = `Lead author's institution is in ${country}. Country does not determine the study's quality ranking.`;
  return (
    <span title={title} style={{
      display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
      padding: '0.15rem 0.5rem', borderRadius: 4, fontSize: '0.68rem',
      border: `1px solid ${color}55`, background: `${color}15`,
      color, fontWeight: 700, letterSpacing: 0.4
    }}>
      🌐 {country}
    </span>
  );
};

// Dossier panel — shows what the realtime disease-intake agent knows
// about the user's condition. This is the agent's answer to the
// user's explicit ask: "shouldn't there be an AI to do disease search,
// so I put in IPF and then in realtime the agent does research?" Yes,
// and here's exactly what it found — transparent by default, with an
// uncertainty score so you know when to trust it vs when to push.
/* ==================== Deep Research Progress ==================== */
// ChatGPT-style stepped progress bar for the two-phase research
// pipeline. Driven off the `progress` state shape in App. Shows:
//   - Mode title + live elapsed-seconds counter
//   - Animated gradient progress bar (% = done steps / total steps)
//   - Stepped checklist: pending / running / done / skipped / error
//     with icon, label, one-line description and live detail text
//     (e.g. "42 unique peer-reviewed sources", "3200 tokens generated")
// Intentionally "honest" — nothing is faked. Every step corresponds
// to real work the backend is doing.
const DeepResearchProgress = ({ progress, onRetrySynth, canRetrySynth }) => {
  if (!progress) return null;
  const steps = progress.steps || [];
  const doneCount = steps.filter(s => s.status === 'done' || s.status === 'skipped').length;
  const totalCount = steps.length;
  const pct = totalCount ? Math.max(6, Math.round((doneCount / totalCount) * 100)) : 0;
  const isError = steps.some(s => s.status === 'error') || !!progress.error;
  const isDone = !progress.active && !isError && doneCount === totalCount;
  const modeLabel = progress.mode === 'repurpose' ? 'Drug and supplement ideas' : 'Detailed report';

  const statusIcon = (s) => {
    const sz = 16;
    if (s.status === 'running') return <Loader size={sz} className="spin" color={theme.accent} />;
    if (s.status === 'done')    return <CheckCircle size={sz} color={theme.green} />;
    if (s.status === 'error')   return <XCircle size={sz} color={theme.red} />;
    if (s.status === 'skipped') return <CheckCircle size={sz} color={theme.textDim} />;
    // pending: empty circle
    return (
      <span style={{
        display: 'inline-block', width: sz, height: sz, borderRadius: 999,
        border: `2px solid ${theme.border}`, boxSizing: 'border-box'
      }} />
    );
  };

  return (
    <div id="mrt-research-progress" role={isError ? 'alert' : 'status'} aria-live="polite" aria-atomic="true" style={{
      ...panelStyle,
      background: `linear-gradient(180deg, ${theme.accentSoft} 0%, ${panelStyle.background} 65%)`,
      borderLeft: `3px solid ${isError ? theme.red : isDone ? theme.green : theme.accent}`
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.3rem' }}>
        <div style={{
          width: 28, height: 28, borderRadius: 8,
          background: `linear-gradient(135deg, ${theme.accent} 0%, ${theme.secondary} 100%)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
          {isError ? <XCircle size={15} color={theme.primaryText} />
            : isDone ? <CheckCircle size={15} color={theme.primaryText} />
            : <Brain size={15} color={theme.primaryText} />}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '1rem', fontWeight: 700, color: theme.text, fontFamily: '"Crimson Pro", Georgia, serif' }}>
            {modeLabel} · {isError ? 'failed' : isDone ? 'complete' : 'in progress'}
          </div>
          <div style={{ fontSize: '0.78rem', color: theme.textDim }}>
            {isDone ? 'The report is ready for review.' : 'Source gathering and report preparation may take several minutes.'}
          </div>
        </div>
        {progress.active && !isError && (
          <span style={{
            fontSize: '0.72rem', color: theme.accent, fontWeight: 600,
            padding: '0.2rem 0.55rem', borderRadius: 999,
            background: `${theme.accent}18`, border: `1px solid ${theme.accent}44`,
            display: 'inline-flex', alignItems: 'center', gap: 6
          }}>
            <span className="mrt-pulse-dot" style={{
              width: 6, height: 6, borderRadius: 999, background: theme.accent, display: 'inline-block'
            }} />
            live
          </span>
        )}
      </div>

      {/* Progress bar */}
      <div style={{
        height: 6, borderRadius: 999, background: theme.panel,
        overflow: 'hidden', margin: '0.7rem 0 1rem'
      }}>
        <div className={progress.active && !isError ? 'mrt-shimmer-bar' : ''} style={{
          width: `${pct}%`, height: '100%', borderRadius: 999,
          background: isError
            ? '#f87171'
            : `linear-gradient(90deg, ${theme.accent} 0%, #6ee7b7 50%, ${theme.accent} 100%)`,
          transition: 'width 400ms ease'
        }} />
      </div>

      {/* Stepped checklist */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
        {steps.map((s, i) => (
          <div key={s.id} style={{
            display: 'flex', alignItems: 'flex-start', gap: '0.6rem',
            opacity: s.status === 'pending' ? 0.5 : 1,
            transition: 'opacity 200ms ease'
          }}>
            <div style={{ paddingTop: 2 }}>{statusIcon(s)}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                display: 'flex', alignItems: 'baseline', gap: '0.4rem', flexWrap: 'wrap'
              }}>
                <span style={{
                  fontSize: '0.88rem', fontWeight: 600,
                  color: s.status === 'running' ? theme.accent : theme.text
                }}>
                  {s.label}
                </span>
              </div>
              <div style={{ fontSize: '0.75rem', color: theme.textDim, marginTop: 1 }}>
                {s.desc}
              </div>
            </div>
          </div>
        ))}
      </div>

      {isError && (
        <div style={{
          marginTop: '0.9rem', padding: '0.6rem 0.8rem', borderRadius: 8,
          background: 'rgba(248, 113, 113, 0.08)', border: '1px solid rgba(248, 113, 113, 0.35)',
          fontSize: '0.82rem', color: '#fca5a5'
        }}>
          <strong>{progress.error || 'Something failed'}</strong>
          <div style={{ marginTop: 3, color: theme.textDim }}>
            {canRetrySynth
              ? 'Your journals and trials are already saved — retrying the report only (no new search).'
              : 'Your research is saved, so trying again is usually fast. If it keeps failing, check the chat bubble for a quick answer.'}
          </div>
          {canRetrySynth && onRetrySynth && (
            <button type="button" style={{ ...btn('primary'), marginTop: '0.6rem' }}
              onClick={onRetrySynth}>
              Retry report (skip search)
            </button>
          )}
        </div>
      )}
    </div>
  );
};

const DossierPanel = ({ dossier, conditionResolution }) => {
  const [expanded, setExpanded] = useState(true);
  if (!dossier || !dossier.canonical) return null;
  return (
    <div style={{ ...panelStyle, borderLeft: `3px solid ${theme.accent}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
        <h3 style={{ margin: 0, color: theme.accent, fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <BookOpen size={18} /> What the AI found about "{dossier.canonical}"
        </h3>
        <button onClick={() => setExpanded(v => !v)} style={{
          background: 'transparent', border: `1px solid ${theme.border}`,
          color: theme.textDim, padding: '0.3rem 0.7rem', borderRadius: 6,
          fontSize: '0.75rem', cursor: 'pointer'
        }}>
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.6rem' }}>
        {dossier.subspecialty && (
          <span style={{
            padding: '0.2rem 0.55rem', borderRadius: 999, fontSize: '0.72rem',
            background: `${theme.accent}15`, color: theme.accent, fontWeight: 600,
            border: `1px solid ${theme.accent}44`
          }}>
            {dossier.subspecialty}
          </span>
        )}
        {dossier.icd10 && (
          <span style={{
            padding: '0.2rem 0.55rem', borderRadius: 999, fontSize: '0.72rem',
            background: `${theme.textDim}15`, color: theme.textDim, fontWeight: 600,
            border: `1px solid ${theme.border}`
          }}>
            ICD-10 {dossier.icd10}
          </span>
        )}
      </div>
      {expanded && (
        <div style={{ marginTop: '0.9rem', fontSize: '0.85rem', color: theme.text, lineHeight: 1.55, display: 'grid', gap: '0.9rem' }}>
          {dossier.synonyms?.length > 0 && (
            <div>
              <div style={{ fontWeight: 700, color: theme.textDim, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
                Other names we searched
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                {dossier.synonyms.map((s, i) => (
                  <span key={i} style={{
                    padding: '0.15rem 0.5rem', borderRadius: 4, fontSize: '0.72rem',
                    background: `${theme.accent}10`, color: theme.accent,
                    border: `1px solid ${theme.accent}44`
                  }}>{s}</span>
                ))}
              </div>
            </div>
          )}
          {dossier.meshTerms?.length > 0 && (
            <div>
              <div style={{ fontWeight: 700, color: theme.textDim, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
                Official medical search terms
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                {dossier.meshTerms.map((m, i) => (
                  <span key={i} style={{
                    padding: '0.15rem 0.5rem', borderRadius: 4, fontSize: '0.72rem',
                    background: `${theme.textDim}15`, color: theme.textDim,
                    border: `1px solid ${theme.border}`
                  }}>{m}</span>
                ))}
              </div>
            </div>
          )}
          {dossier.landmarkTrials?.length > 0 && (
            <div>
              <div style={{ fontWeight: 700, color: theme.textDim, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
                Key studies
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                {dossier.landmarkTrials.map((t, i) => (
                  <span key={i} title={t.topic || t.name} style={{
                    padding: '0.2rem 0.55rem', borderRadius: 4, fontSize: '0.75rem',
                    background: `${theme.accent}15`, color: theme.accent, fontWeight: 700,
                    border: `1px solid ${theme.accent}44`
                  }}>
                    {t.acronym || t.name}
                  </span>
                ))}
              </div>
            </div>
          )}
          {dossier.redFlags?.length > 0 && (
            <div>
              <div style={{ fontWeight: 700, color: theme.red, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
                Safety things found in the research
              </div>
              <ul style={{ margin: 0, paddingLeft: '1.2rem', color: theme.text }}>
                {dossier.redFlags.map((r, i) => (
                  <li key={i} style={{ fontSize: '0.82rem', marginBottom: 2 }}>{r}</li>
                ))}
              </ul>
            </div>
          )}
          {dossier.commonComorbidities?.length > 0 && (
            <div style={{ fontSize: '0.82rem', color: theme.textDim }}>
              <strong style={{ color: theme.text }}>Other health conditions to watch for:</strong>{' '}
              {dossier.commonComorbidities.join(', ')}
            </div>
          )}
          {dossier.notes && (
            <div style={{
              fontSize: '0.78rem', color: theme.textDim, fontStyle: 'italic',
              padding: '0.5rem', borderRadius: 6, background: `${theme.textDim}08`,
              border: `1px solid ${theme.border}`
            }}>
              Notes: {dossier.notes}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// Quality-breakdown panel — plain-language summary of how sources were checked.
const QualityPanel = ({ qb }) => {
  const [expanded, setExpanded] = useState(false);
  const [integrityFlaggedOpen, setIntegrityFlaggedOpen] = useState(false);
  if (!qb) return null;
  const hasExclusions = (qb.retractedExcluded || 0) > 0 || (qb.predatoryExcluded || 0) > 0;
  return (
    <div style={{
      ...panelStyle,
      borderLeft: `3px solid ${theme.accent}`,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
        <h3 style={{ margin: 0, color: theme.accent, fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Shield size={18} /> How we checked the medical literature · {qb.totalScreened} papers reviewed
        </h3>
        <button onClick={() => setExpanded(v => !v)} style={{
          background: 'transparent', border: `1px solid ${theme.border}`,
          color: theme.textDim, padding: '0.3rem 0.7rem', borderRadius: 6,
          fontSize: '0.75rem', cursor: 'pointer'
        }}>
          {expanded ? 'Hide details' : 'Show details'}
        </button>
      </div>
      <p style={{ margin: '0.5rem 0 0', fontSize: '0.84rem', color: theme.textDim, lineHeight: 1.5 }}>
        We search PubMed, Europe PMC, OpenAlex, and Cochrane on every run — the knowledge base helps us find the right topics, not replace live search.
        {qb.citedCount ? ` Every paper here is screened and ranked; the ${qb.citedCount} most relevant are read in depth and are the ones cited below.` : ' Every paper here is screened and ranked; the most relevant are read in depth and are the ones cited below.'}
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.6rem' }}>
        <span style={{
          padding: '0.25rem 0.6rem', borderRadius: 999, fontSize: '0.72rem',
          background: `${theme.green}22`, color: theme.green, fontWeight: 700,
          border: `1px solid ${theme.green}55`
        }}>
          {qb.totalScreened - (qb.retractedExcluded || 0) - (qb.predatoryExcluded || 0)} papers passed our quality checks
        </span>
        {(qb.retractedExcluded || 0) > 0 && (
          <span style={{
            padding: '0.25rem 0.6rem', borderRadius: 999, fontSize: '0.72rem',
            background: `${theme.textDim}18`, color: theme.textDim, fontWeight: 600,
            border: `1px solid ${theme.border}`
          }}>
            {qb.retractedExcluded} retracted paper{qb.retractedExcluded === 1 ? '' : 's'} filtered out
          </span>
        )}
        {(qb.predatoryExcluded || 0) > 0 && (
          <span style={{
            padding: '0.25rem 0.6rem', borderRadius: 999, fontSize: '0.72rem',
            background: `${theme.textDim}18`, color: theme.textDim, fontWeight: 600,
            border: `1px solid ${theme.border}`
          }}>
            {qb.predatoryExcluded} low-quality publisher{qb.predatoryExcluded === 1 ? '' : 's'} filtered out
          </span>
        )}
        {(qb.preprintsInPool || 0) > 0 && (
          <span style={{
            padding: '0.25rem 0.6rem', borderRadius: 999, fontSize: '0.72rem',
            background: `${theme.yellow}22`, color: theme.yellow, fontWeight: 700,
            border: `1px solid ${theme.yellow}55`
          }}>
            {qb.preprintsInPool} early draft{qb.preprintsInPool === 1 ? '' : 's'} flagged (preprints — not yet checked by other experts)
          </span>
        )}
      </div>
      <details
        open={integrityFlaggedOpen}
        onToggle={(e) => setIntegrityFlaggedOpen(e.target.open)}
        style={{ marginTop: '0.65rem', fontSize: '0.82rem', color: theme.textDim, lineHeight: 1.55 }}
      >
        <summary style={{ cursor: 'pointer', color: theme.accent, fontWeight: 600 }}>
          What are low-integrity publishers?
        </summary>
        <div style={{ marginTop: '0.45rem' }}>
          <strong style={{ color: theme.text }}>Publishers flagged for documented integrity concerns.</strong>
          {' '}These are venues with publicly documented pay-to-publish practices, mass retractions, or similar
          integrity issues — not a judgment about any country or author. This is{' '}
          <strong style={{ color: theme.text }}>not</strong> the same as country of origin — we do not hide papers
          from any country. Examples frequently cited in integrity watchlists include:
          <ul style={{ margin: '0.45rem 0', paddingLeft: '1.2rem' }}>
            {INTEGRITY_FLAGGED_PUBLISHER_EXAMPLES.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
          Papers from any country can still be found; the flag only changes how we rank them, not whether they show up in search.
          We do not send flagged papers from these sources to the AI when we spot them; solid
          research from any part of the world can still be used on its own merits.
        </div>
      </details>
      {expanded && (
        <div style={{ marginTop: '0.85rem', fontSize: '0.82rem', color: theme.textDim, lineHeight: 1.55 }}>
          <div style={{ marginBottom: '0.5rem' }}>
            <strong style={{ color: theme.text }}>How this works.</strong>
            {' '}                  We score each paper on the journal's reputation, the study type (a real study vs. an opinion piece),
            how recent it is, and how often other papers cite it. Papers that were pulled back (retracted) and
            publishers known for quality problems are removed before the AI reads them. Early drafts (preprints) are
            kept but marked as not yet checked by other experts.
          </div>
          {(qb.topTierInPromptPack > 0 || qb.rctOrMetaInPromptPack > 0) && (
            <div style={{ marginBottom: '0.5rem', fontSize: '0.78rem', color: theme.textDim }}>
              Technical detail: {qb.topTierInPromptPack} top-journal · {qb.rctOrMetaInPromptPack} clinical trial or systematic review in the analysis set.
            </div>
          )}
          {(qb.retractedTitles || []).length > 0 && (
            <div style={{ marginTop: '0.6rem' }}>
              <div style={{ color: theme.red, fontWeight: 700, marginBottom: '0.25rem' }}>
                Retracted papers we did not send to the AI:
              </div>
              <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
                {qb.retractedTitles.map((r, i) => (
                  <li key={i}>
                    "{(r.title || '(untitled)').slice(0, 140)}" ({r.journal || 'journal unknown'})
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(qb.predatoryTitles || []).length > 0 && (
            <div style={{ marginTop: '0.6rem' }}>
              <div style={{ color: theme.red, fontWeight: 700, marginBottom: '0.25rem' }}>
                Papers from low-quality publishers we left out:
              </div>
              <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
                {qb.predatoryTitles.map((r, i) => (
                  <li key={i}>
                    "{(r.title || '(untitled)').slice(0, 120)}" — {r.publisher || r.journal}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {qb.countryCounts && Object.keys(qb.countryCounts).length > 0 && (
            <div style={{ marginTop: '0.6rem' }}>
              <div style={{ color: theme.text, fontWeight: 700, marginBottom: '0.25rem' }}>
                First-author country distribution in clean pool:
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                {Object.entries(qb.countryCounts)
                  .sort(([,a],[,b]) => b - a)
                  .slice(0, 20)
                  .map(([code, n]) => (
                    <span key={code} style={{ display: 'inline-flex', gap: '0.25rem', alignItems: 'center' }}>
                      <CountryBadge country={code} />
                      <span style={{ fontSize: '0.75rem', color: theme.textDim }}>× {n}</span>
                    </span>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/* ==================== Cross-AI Validator Panel ==================== */
// Renders the second-AI (Perplexity / OpenAI / xAI) audit of Claude's
// output. This is the safeguard against hallucinated citations:
// an INDEPENDENT model rechecks every factual claim against the same
// grounded evidence pack and flags disputed / unsupported / hallucinated.
const agreementColor = (level) => {
  if (level === 'high') return theme.green;
  if (level === 'moderate') return theme.yellow;
  if (level === 'low') return theme.red;
  return theme.textDim;
};

// "Dorothy can teach it": a small, unobtrusive way for the user to flag
// an error they spotted in the current report. On submit it POSTs to the
// research API's flag-error mode, which saves the mistake against this
// condition so future reports are told not to repeat it.
const FlagErrorBox = ({ condition }) => {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [status, setStatus] = useState(null); // null | 'saving' | 'saved' | 'error'
  const cond = String(condition || '').trim();
  if (!cond) return null;

  const submit = async () => {
    const claim = text.trim();
    if (!claim) return;
    setStatus('saving');
    try {
      const r = await fetch('/api/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'flag-error', condition: cond, claim })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setStatus('saved');
      setText('');
    } catch (_) {
      setStatus('error');
    }
  };

  return (
    <div style={{ marginTop: '0.9rem', paddingTop: '0.75rem', borderTop: `1px solid ${theme.border}` }}>
      {!open ? (
        <button
          type="button"
          onClick={() => { setOpen(true); setStatus(null); }}
          style={{
            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            color: theme.textDim, fontSize: '0.82rem', fontFamily: 'inherit',
            textDecoration: 'underline'
          }}
        >
          Flag an error in this report
        </button>
      ) : status === 'saved' ? (
        <p style={{ margin: 0, color: theme.green, fontSize: '0.85rem' }}>
          Saved — future reports for this condition will be told not to repeat this.
        </p>
      ) : (
        <div>
          <p style={{ margin: '0 0 0.4rem', color: theme.textDim, fontSize: '0.82rem' }}>
            Spotted something wrong? Tell us what it got wrong and we'll make sure the next
            report for this condition doesn't repeat it.
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            placeholder="e.g. It said Drug X is FDA-approved for this condition, but it is not."
            style={{ ...inputStyle, resize: 'vertical', marginBottom: '0.5rem' }}
          />
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={submit}
              disabled={!text.trim() || status === 'saving'}
              style={btn('primary', !text.trim() || status === 'saving')}
            >
              {status === 'saving' ? 'Saving…' : 'Save this correction'}
            </button>
            <button
              type="button"
              onClick={() => { setOpen(false); setStatus(null); }}
              style={btn('ghost')}
            >
              Cancel
            </button>
            {status === 'error' && (
              <span style={{ color: theme.red, fontSize: '0.82rem' }}>
                Couldn't save — please try again.
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const ValidatorPanel = () => {
  // Client mandate: do NOT surface the second-AI score panel
  // ("Checked by a second AI" / 72/100 / Backed up). Validation may
  // still run server-side to strip bad claims; the reader never sees it.
  return null;
};

const ValidatorStat = ({ label, n, color, Icon }) => (
  <div style={{
    padding: '0.6rem 0.75rem', background: theme.panel,
    border: `1px solid ${color}33`, borderRadius: 8,
    display: 'flex', alignItems: 'center', gap: '0.5rem'
  }}>
    <Icon size={18} color={color} />
    <div>
      <div style={{ fontSize: '1.15rem', fontWeight: 700, color, lineHeight: 1 }}>{n}</div>
      <div style={{ fontSize: '0.75rem', color: theme.textDim, marginTop: 2 }}>{label}</div>
    </div>
  </div>
);

const ValidatorList = ({ title, color, items }) => (
  <div style={{ marginTop: '0.9rem' }}>
    <h4 style={{ margin: '0 0 0.4rem', color, fontSize: '0.9rem' }}>{title}</h4>
    <div style={{ display: 'grid', gap: '0.4rem' }}>
      {items.map((it, i) => (
        <div key={i} style={{
          padding: '0.5rem 0.75rem', borderLeft: `3px solid ${color}`,
          background: theme.panel, borderRadius: 4
        }}>
          <div style={{ fontSize: '0.9rem', wordBreak: 'break-word' }}>
            {it.isUrl
              ? <a href={it.primary} target="_blank" rel="noopener">{it.primary}</a>
              : <span>{it.primary}</span>}
          </div>
          {it.reason && (
            <div style={{ fontSize: '0.8rem', color: theme.textDim, marginTop: 2 }}>
              {it.reason}
            </div>
          )}
          {it.correction && (
            <div style={{ fontSize: '0.8rem', color: theme.green, marginTop: 2 }}>
              → {it.correction}
            </div>
          )}
        </div>
      ))}
    </div>
  </div>
);

/* ==================== Evidence-grade banner (Pillar 1) ==================== */
// Honest "thin / unverified evidence" banner shown above the report when
// the grounding-sufficiency gate graded the evidence thin or dossier-only.
// Never blocks the report — it only sets expectations. A `strong` grade
// (curated / well-grounded conditions) shows nothing.
const EvidenceGradeBanner = ({ grade }) => {
  if (!grade || grade.tier === 'strong') return null;
  const color = theme.yellow;
  // Short title (distinct from the body sentence so the copy isn't
  // restated), one explanatory sentence, then a brief evidence detail.
  const title = grade.tier === 'dossier-only' ? 'Unverified evidence base' : 'Thin evidence base';
  const detail = grade.tier === 'dossier-only'
    ? 'No peer-reviewed papers could be verified, so this report relies on a general condition summary and current web results.'
    : grade.packCapped
      // Never say "only N could be found" when N is the review cap — the search
      // returned more, and a reader who checks will catch it immediately.
      ? `${grade.totalFound} papers were gathered and the ${grade.realPaperCount} most relevant were reviewed in depth${grade.topTierCount ? `, of which ${grade.topTierCount} ${grade.topTierCount === 1 ? 'is a randomized controlled trial or meta-analysis' : 'are randomized controlled trials or meta-analyses'}` : ''}. Fewer high-tier studies than we would like for a firm summary.`
      : `${grade.realPaperCount} verified paper${grade.realPaperCount === 1 ? '' : 's'}${grade.topTierCount ? ` (${grade.topTierCount} randomized controlled trial or meta-analysis)` : ''} met the bar for a well-supported summary.`;
  return (
    <div style={{
      ...panelStyle,
      borderLeft: `4px solid ${color}`,
      background: `${color}12`
    }}>
      <h3 style={{ margin: '0 0 0.35rem', color, display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '1rem' }}>
        <AlertTriangle size={18} /> {title}
      </h3>
      <p style={{ margin: 0, color: theme.text, fontSize: '0.88rem', lineHeight: 1.55 }}>
        Limited high-quality evidence was found for this condition — treat the following as a
        starting point to discuss with a clinician, not a vetted summary.
      </p>
      <p style={{ margin: '0.5rem 0 0', fontSize: '0.78rem', color: theme.textDim }}>
        {detail}
      </p>
    </div>
  );
};

/* ==================== Validation mismatch banner ==================== */
const ValidationMismatchBanner = () => {
  // Client mandate: do NOT surface second-AI vs first-AI disagreement
  // banners ("the second AI thinks…", dispute lists, agreement scores).
  // Validation may still run server-side and strip bad claims silently.
  return null;
};

/* ==================== Research Tab ==================== */
const ResearchTab = ({ patient, audience, busy, runResearch, researchText, treatments,
                        candidates, combos, repurposeText, trialsData, drugScreen,
                        validation, validationMismatch, conditionResolution, evidenceGrade,
                        evidenceSummary, evidencePack, dossier, progress, coverageAudit,
                        chatHistory, userQuery, setUserQuery, sendChat, onAudit, runtimeConfig,
                        runMeta, setTab, onDismissMismatch, onRetrySynth, canRetrySynth,
                        getCompletionContract }) => {
  const cond = patient.condition || 'this condition';
  const savedDemo = trialsData?.savedDemo === true;
  const trialStudies = normalizeTrialStudies(trialsData?.studies);
  const isIpf = /idiopathic\s*pulmonary\s*fibrosis|\bipf\b|\buip\b/i.test(cond);
  const [translatedText, setTranslatedText] = useState('');
  const [copyCompletion, setCopyCompletion] = useState(null);
  const reportAllowedUrls = useMemo(() => {
    return buildAllowedUrlSet(trialsData, evidenceSummary || { topRanked: evidencePack });
  }, [evidenceSummary, evidencePack, trialsData]);
  // Split data-bearing approved cards from KB-injected stubs. Derived here
  // from the in-scope `treatments` prop — these are referenced throughout
  // the approved-treatments render below.
  const realTreatments = useMemo(() => treatments.filter((t) => !t._approvedStub), [treatments]);
  const stubTreatments = useMemo(() => treatments.filter((t) => t._approvedStub), [treatments]);
  const keepHedges = !!evidenceGrade && evidenceGrade.tier && evidenceGrade.tier !== 'strong';
  const renderedResearchTextBase = polishReportForDisplay(
    (treatments.length > 0 && allApprovedDrugsRendered(evidenceSummary?.pipelineDrugs, treatments))
      ? stripApprovedTreatmentsSection(translatedText || researchText)
      : (translatedText || researchText),
    { keepHedges }
  );
  // Section 4 can state "no recruiting trials" near the top while the full
  // clinical-trials table renders far below —
  // forcing a blind scroll. Inject an honest one-line recruiting summary +
  // an anchor jump to the table right after the Section 4 heading, so the
  // reader is told the reality and can jump straight to the list. Minimal,
  // non-destructive (only adds a line after the heading; no anchors moved).
  const renderedResearchText = useMemo(() => {
    let txt = stripForeignDiseaseContamination(renderedResearchTextBase, patient.condition || '');
    // Research prose and citations are server-sealed. The browser must never
    // attach a "closest" source after finalization because generic token
    // overlap cannot establish support for an exact quantitative claim.
    const studies = Array.isArray(trialsData?.studies) ? trialsData.studies : [];
    if (!txt || !studies.length) return txt;
    // "N of M shown" must describe the rows actually on screen. Counting the
    // whole result set while displaying a capped subset made the two numbers
    // disagree with the table underneath them.
    const shownStudies = studies.slice(0, TRIAL_ROW_DISPLAY_LIMIT);
    const totalTrials = shownStudies.length;
    const acceptingCount = shownStudies.filter((s) => s.acceptingNewPatients === true).length;
    const summary = acceptingCount > 0
      ? `**${acceptingCount} of ${totalTrials} shown** ${acceptingCount === 1 ? 'study is' : 'studies are'} currently accepting new patients.`
      : `**0 of ${totalTrials} shown** studies are currently accepting new patients.`;
    const jumpLine = `\n\n${summary} [Jump to the full ${savedDemo ? 'saved, not-live trial list' : 'clinical trials table'} ↓](#clinical-trials)\n`;
    const headingRe = /^(#{2,3}\s*4\.[^\n]*)$/m;
    if (headingRe.test(txt)) return txt.replace(headingRe, `$1${jumpLine}`);
    return txt;
  }, [renderedResearchTextBase, trialsData, evidenceSummary, evidencePack, patient.condition, savedDemo]);
  useEffect(() => {
    let active = true;
    setCopyCompletion(null);
    if (!String(renderedResearchText || '').trim()) return () => { active = false; };
    getCompletionContract('research')
      .then((contract) => {
        if (active) setCopyCompletion({ reportContent: 'research', contract });
      })
      .catch(() => {
        if (active) setCopyCompletion(null);
      });
    return () => { active = false; };
  }, [renderedResearchText, getCompletionContract]);
  const profileCoherenceIssue = useMemo(() => checkProfileCoherence(patient), [patient]);
  const baseQuickPrompts = [
    `Why did you rank the top treatment #1 over the others? Walk me through the tradeoff.`,
    `Check every treatment you recommended against my current medications for interactions.`,
    `What is the single most important question I should ask my doctor next week?`,
    `What are the realistic side effects I should actually expect, ranked by how common they are?`,
    `If I only had one treatment option to pursue next month, which one and why?`,
    `What side effects should make me call my doctor right away?`,
    `Non-drug practical things I can start doing this week for ${cond}.`,
    `What does the evidence say about combining the top 2 treatments?`
  ];
  const ipfQuickPrompts = [
    `Pirfenidone vs nintedanib — given my patient profile, which antifibrotic has a better risk-benefit tradeoff and why?`,
    `Was prednisone + azathioprine + NAC triple therapy ever shown to help IPF? What does PANTHER-IPF say?`,
    `Is there any evidence for vitamin D, N-acetylcysteine monotherapy, or other supplements in IPF?`,
    `How aggressive should I be about treating GERD given the IPF micro-aspiration hypothesis?`,
    `When do doctors usually start checking if someone can get a lung transplant? What would rule it out (reasons it can't be done)?`,
    `What pulmonary rehab / exercise training is evidence-based for IPF?`,
    `Are there any drug combinations being trialed on top of standard antifibrotics? What phase?`,
    `How should I interpret a ~5–10% FVC decline over 12 months — is it time to change therapy?`
  ];
  const quickPrompts = isIpf ? ipfQuickPrompts : baseQuickPrompts;
  // Dorothy non-negotiable: Research tab itself must show TWO labeled
  // sections (~25 never-researched + ~25 researched-not-approved) — never
  // one flat "Drug & supplement ideas (N)" pile with a tab pointer.
  const { neverResearched, researchedNotApproved, evidenceStatusUnknown } = useMemo(
    () => partitionCandidates(candidates, patient?.condition || ''),
    [candidates, patient?.condition]
  );
  // Count what the reader can actually see. Reporting every parsed candidate
  // disagreed with the per-section breakdown underneath it once the sections
  // became capped ("Found 14" above "10 + 3 + 0").
  const shownIdeaCount =
    neverResearched.length + researchedNotApproved.length + evidenceStatusUnknown.length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <AdSlot runtimeConfig={runtimeConfig} slotKey="researchTop" />
      <div style={panelStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: 0, color: theme.accent, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Brain size={22} /> Detailed Condition Report
            </h2>
            <p style={{ margin: '0.25rem 0 0', color: theme.textDim, fontSize: '0.82rem', fontStyle: 'italic' }}>
              A careful search of journals, trials, treatments, and experts (<strong>often about 5 to 6 minutes</strong> — not a quick answer)
            </p>
          </div>
          <button style={btn('primary', !!busy || !profileCoherenceIssue.ok)} disabled={!!busy || !profileCoherenceIssue.ok}
            onClick={() => runResearch()}>
            {busy ? <><Loader size={16} className="spin" /> Running full report…</>
              : <><Search size={16} /> Run Full Report</>}
          </button>
        </div>
        {!profileCoherenceIssue.ok && (
          <div style={{
            marginTop: '0.75rem', padding: '0.65rem 0.85rem', borderRadius: 8,
            border: `1px solid ${theme.red}66`, background: `${theme.red}12`,
            color: theme.red, fontSize: '0.88rem', lineHeight: 1.5
          }}>
            {profileCoherenceIssue.message}
          </div>
        )}
        <p style={{ color: theme.textDim, fontSize: '0.9rem' }}>
          Targeted report: approved options identified in this search, clinical studies, treatments in development, supportive care, and research ideas to discuss with your clinician — one PDF.
        </p>
        {treatments.length > 0 && (
          <p style={{ color: theme.green, fontSize: '0.85rem' }}>
            {realTreatments.length > 0
              ? <>✓ Found {realTreatments.length} detailed approved-treatment card{realTreatments.length === 1 ? '' : 's'}{stubTreatments.length > 0 ? ` (plus ${stubTreatments.length} more FDA-approved option${stubTreatments.length === 1 ? '' : 's'} listed for reference)` : ''} in your report.</>
              : <>✓ Found {stubTreatments.length} FDA-approved option{stubTreatments.length === 1 ? '' : 's'} for this condition (listed for reference — see guidelines for per-drug details).</>}
          </p>
        )}
        {shownIdeaCount > 0 && (
          <p style={{ color: theme.green, fontSize: '0.85rem' }}>
            ✓ Found {shownIdeaCount} drug &amp; supplement idea{shownIdeaCount === 1 ? '' : 's'} (OTC supplements and prescription ideas with source links).
          </p>
        )}
        {runMeta?.repurposeQuality && (
          (runMeta.repurposeQuality.linkedCandidates != null
            ? runMeta.repurposeQuality.linkedCandidates
            : runMeta.repurposeQuality.totalCandidates) < 50
        ) && (
          <p style={{ color: theme.yellow, fontSize: '0.85rem' }}>
            Found {runMeta.repurposeQuality.linkedCandidates != null
              ? runMeta.repurposeQuality.linkedCandidates
              : runMeta.repurposeQuality.totalCandidates} ideas with a source link. The report does not add items to meet a quota.
          </p>
        )}
      </div>

      <DeepResearchProgress progress={progress} onRetrySynth={onRetrySynth} canRetrySynth={canRetrySynth} />

      <EvidenceGradeBanner grade={evidenceGrade} />

      <DossierPanel dossier={dossier} conditionResolution={conditionResolution} />

      <ValidationMismatchBanner />

      <ValidatorPanel validation={validation} onAudit={onAudit} canAudit={!!researchText} condition={patient.condition} />

      {treatments.length > 0 && (
        <div style={panelStyle}>
          <h3 style={{ margin: '0 0 0.35rem', color: theme.accent, fontSize: '1.05rem' }}>
            FDA-approved treatments for this condition ({treatments.length})
          </h3>
          <p style={{ margin: '0 0 0.75rem', color: theme.textDim, fontSize: '0.86rem', lineHeight: 1.55 }}>
            Approved options identified in this search, with source links on each card. This may not be exhaustive.
          </p>
          {realTreatments.length > 0 && (
            <div style={{ display: 'grid', gap: '0.85rem' }}>
              {realTreatments.map((t, i) => (
                <TreatmentCard key={`tx-${i}`} t={t} rank={i + 1} allowedUrls={reportAllowedUrls} />
              ))}
            </div>
          )}
          {stubTreatments.length > 0 && (
            <div style={{ marginTop: realTreatments.length > 0 ? '1rem' : 0 }}>
              <div style={{ fontSize: '0.78rem', fontWeight: 700, color: theme.textDim, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>
                Other FDA-approved treatments with verified labels
              </div>
              <div style={{ display: 'grid', gap: '0.4rem' }}>
                {stubTreatments.map((t, i) => (
                  <div key={`stub-${i}`} style={{ padding: '0.5rem 0.7rem', borderRadius: 8, border: `1px solid ${theme.border}`, background: theme.panel }}>
                    <span style={{ fontWeight: 700, color: theme.text }}><InlineTitle text={t.treatment} /></span>
                    {t.provider && (
                      <span style={{ color: theme.textDim, fontSize: '0.82rem' }}> — <InlineMD text={String(t.provider).replace(/^Mechanism:\s*/i, '')} /></span>
                    )}
                  </div>
                ))}
              </div>
              <div style={{ fontSize: '0.75rem', color: theme.textDim, marginTop: 6, lineHeight: 1.5 }}>
                These entries are shown only when an exact FDA label was available. No efficacy or safety score is inferred from the label alone.
              </div>
            </div>
          )}
        </div>
      )}

      {/* Centers & Experts section */}
      {dossier?.topCenters?.length > 0 && (
        <div style={panelStyle}>
          <h3 style={{ margin: '0 0 0.35rem', color: theme.accent, fontSize: '1.05rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Building size={18} /> Condition-Focused Centers ({dossier.topCenters.length})
          </h3>
          <p style={{ margin: '0 0 0.75rem', color: theme.textDim, fontSize: '0.86rem', lineHeight: 1.55 }}>
            Academic medical centers identified for specialized expertise in {patient.condition || 'this condition'}. This is not a quality ranking.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '0.75rem' }}>
            {dossier.topCenters.map((c, i) => (
              <div key={`center-${i}`} style={{
                padding: '0.9rem 1rem',
                borderRadius: 10,
                border: `1px solid ${theme.accent}33`,
                background: `linear-gradient(135deg, ${theme.panel} 0%, ${theme.accentSoft || theme.panel} 100%)`,
                boxShadow: '0 2px 8px rgba(0,0,0,0.06)'
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.6rem' }}>
                  <div style={{
                    width: 32, height: 32, borderRadius: 8,
                    background: `${theme.accent}18`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0
                  }}>
                    <Building size={16} color={theme.accent} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, color: theme.text, fontSize: '0.92rem', lineHeight: 1.3 }}>{c.name}</div>
                    {(c.city || c.country) && (
                      <div style={{ color: theme.textDim, fontSize: '0.78rem', marginTop: 3, display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                        <span style={{ opacity: 0.7 }}>📍</span> {[c.city, c.country].filter(Boolean).join(', ')}
                      </div>
                    )}
                  </div>
                </div>
                {c.why && (
                  <div style={{
                    color: theme.textDim, fontSize: '0.8rem', marginTop: 8, lineHeight: 1.5,
                    padding: '0.5rem 0.6rem', background: `${theme.text}08`, borderRadius: 6
                  }}>
                    {c.why}
                  </div>
                )}
              </div>
            ))}
          </div>
          {dossier?.keyInvestigators?.length > 0 && (
            <div style={{ marginTop: '1.25rem' }}>
              <h4 style={{ margin: '0 0 0.6rem', color: theme.accent, fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <User size={16} /> Key Researchers ({dossier.keyInvestigators.length})
              </h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '0.6rem' }}>
                {dossier.keyInvestigators.map((inv, i) => (
                  <div key={`inv-${i}`} style={{
                    padding: '0.7rem 0.85rem',
                    borderRadius: 8,
                    border: `1px solid ${theme.border}`,
                    background: theme.panel
                  }}>
                    <div style={{ fontWeight: 600, color: theme.text, fontSize: '0.88rem' }}>{inv.name}</div>
                    {inv.affiliation && (
                      <div style={{ color: theme.textDim, fontSize: '0.78rem', marginTop: 2 }}>{inv.affiliation}</div>
                    )}
                    {inv.why && (
                      <div style={{ color: theme.textDim, fontSize: '0.78rem', marginTop: 4, fontStyle: 'italic' }}>{inv.why}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {researchText && (
        <div id="mrt-research-export-target" style={{ ...panelStyle, borderColor: `${theme.accent}55` }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.9rem', gap: '0.6rem', flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0, color: theme.accent, fontSize: '1.1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Brain size={18} /> Report for {patient.condition || 'this condition'}
            </h3>
            <AnalysisExportBar
              getElement={() => document.getElementById('mrt-research-export-target')}
              exportBaseFilename={`research-${(patient.condition || 'analysis').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`}
              disabled={!!busy || !renderedResearchText}
              text={renderedResearchText}
              getCompletionContract={getCompletionContract}
            />
          </div>
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
              <button
                onClick={() => {
                  // Dorothy: "do we have the ability to ask it why
                  // it missed something or got something wrong?"
                  // This primes the follow-up chat with that exact
                  // question pattern and scrolls to the chat box.
                  setUserQuery('I would like to discuss a treatment that may be missing from this report with my doctor. Please explain what evidence would be needed to assess it, why it may not appear here, and what questions I should bring to my appointment.');
                  setTimeout(() => {
                    const el = document.querySelector('input[placeholder^="Ask about"], input[placeholder^="Type a disease"]');
                    if (el) {
                      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      el.focus();
                    }
                  }, 50);
                }}
                style={{ background: theme.accentSoft, border: `1px solid ${theme.accentEdge}`, color: theme.accent, padding: '0.3rem 0.7rem', borderRadius: 6, fontSize: '0.75rem', cursor: 'pointer', fontWeight: 600 }}
                title="Prepare questions about a treatment that may be missing"
                data-pdf-exclude="1"
              >
                Prepare a doctor-discussion question
              </button>
              <button
                onClick={async () => {
                  try {
                    const contract = cachedCompletionForClipboard(copyCompletion, 'research');
                    if (!contract) {
                      throw new Error('This report is still being verified for copying. Please try again.');
                    }
                    const coverage = contract.coverageMessages?.length
                      ? `\nWhat may be missing: ${contract.coverageMessages.join(' ')}`
                      : '';
                    const write = navigator.clipboard.writeText(publicTextOrFallback(
                      `${contract.label}${coverage}\n\n${MEDICAL_DISCLAIMER}\n\n${contract.canonicalContent}`
                    ));
                    await write;
                    notifyUser('Report copied to the clipboard.', 'success');
                  } catch (e) {
                    notifyUser(e?.message || 'This report is not ready to copy.', 'error');
                  }
                }}
                style={{ background: 'transparent', border: `1px solid ${theme.border}`, color: theme.textDim, padding: '0.3rem 0.7rem', borderRadius: 6, fontSize: '0.75rem', cursor: 'pointer' }}
                title="Copy markdown to clipboard (includes disclaimer)"
                data-pdf-exclude="1"
              >
                Copy
              </button>
              <AnalysisLanguageToolbar
                sourceText={researchText}
                translatedText={translatedText}
                setTranslatedText={setTranslatedText}
                exportElementId="mrt-research-export-target"
                exportBaseFilename={`research-${(patient.condition || 'analysis').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`}
                getCompletionContract={getCompletionContract}
              />
          </div>
          {translatedText && (
            <div data-pdf-exclude="1" style={{ marginBottom: '0.6rem', fontSize: '0.78rem', color: theme.textDim }}>
              You're seeing the translated version. The original English does not change.
            </div>
          )}
          <Markdown text={renderedResearchText} allowedUrls={reportAllowedUrls} />
        </div>
      )}

      {(trialStudies.length > 0 || trialCoverageMessage(trialsData)) && (
        <div id="clinical-trials" style={panelStyle}>
          <h3 style={{ margin: '0 0 0.35rem', color: theme.accent, fontSize: '1.05rem' }}>
            {savedDemo ? 'Saved demo — not live trial list' : 'Clinical trials'} ({Number.isFinite(Number(trialsData?.returned)) ? Number(trialsData.returned) : trialStudies.length})
          </h3>
          <p style={{ margin: '0 0 0.75rem', color: theme.textDim, fontSize: '0.86rem', lineHeight: 1.55 }}>
            {trialCollectionDescription(trialsData)} Searches include all years, not just 2025.
            <strong style={{ color: theme.text }}> Open-label extension</strong> records may provide continued study treatment for some participants from an earlier trial; check each record's status and criteria.
            <strong style={{ color: theme.text }}> Expanded Access</strong> is compassionate use outside a trial when you do not qualify.
          </p>
          {trialCoverageMessage(trialsData) && (
            <p role="status" style={{ margin: '0 0 0.75rem', color: theme.yellow, fontSize: '0.86rem', lineHeight: 1.55 }}>
              <strong>Incomplete trial coverage:</strong> {trialCoverageMessage(trialsData)}
            </p>
          )}
          <TrialsTable data={trialsData} />
        </div>
      )}

      {candidates.length > 0 && (
        <div style={panelStyle}>
          <h3 style={{ margin: 0, color: theme.accent, fontSize: '1.05rem' }}>
            {candidates.length} drug &amp; supplement idea{candidates.length === 1 ? '' : 's'}
            <span style={{ color: theme.textDim, fontWeight: 500, fontSize: '0.85rem', marginLeft: '0.5rem' }}>
              · {neverResearched.length} with no condition-specific study identified · {researchedNotApproved.length} with condition-specific research · {evidenceStatusUnknown.length} unclear
            </span>
          </h3>
          <p style={{ margin: '0.35rem 0 0', color: theme.textDim, fontSize: '0.86rem', lineHeight: 1.55 }}>
            Conversation starters with your doctor, not prescriptions — split into two lists below.
          </p>
        </div>
      )}

      {(neverResearched.length > 0 || researchedNotApproved.length > 0) && <RepurposeExplainer />}

      {/* SECTION 1 — never researched for this condition */}
      {neverResearched.length > 0 && (
        <div style={{
          ...panelStyle,
          borderLeft: `4px solid ${theme.accent}`,
          background: `linear-gradient(90deg, ${theme.accent}12 0%, ${theme.panel} 55%)`
        }}>
          <h3 style={{ margin: '0 0 0.35rem', color: theme.accent, fontSize: '1.05rem', display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
            <Brain size={18} />
            Drug &amp; Supplement Repurposing Ideas
            <span style={{ color: theme.textDim, fontWeight: 500, fontSize: '0.85rem' }}>({neverResearched.length})</span>
          </h3>
          <p style={{ margin: '0 0 0.85rem', color: theme.textDim, fontSize: '0.86rem', lineHeight: 1.55 }}>
            <strong style={{ color: theme.text }}>No condition-specific study was identified in this search.</strong>
            The indirect rationale comes from other conditions or biological research and does not imply benefit.
            Source links in this section are not studies of {cond}.
          </p>
          <div style={{ display: 'grid', gap: '0.85rem' }}>
            {neverResearched.map((c, i) => (
              <CandidateCard
                key={`rd-nr-${i}`}
                c={c}
                rank={i + 1}
                highlightMechanistic={true}
                audience={audience}
                conditionLabel={cond}
                allowedUrls={reportAllowedUrls}
              />
            ))}
          </div>
        </div>
      )}

      {evidenceStatusUnknown.length > 0 && (
        <div style={panelStyle}>
          <h3 style={{ margin: '0 0 0.35rem', color: theme.yellow, fontSize: '1.05rem' }}>
            Condition-specific study status unclear ({evidenceStatusUnknown.length})
          </h3>
          <p style={{ margin: '0 0 0.85rem', color: theme.textDim, fontSize: '0.86rem', lineHeight: 1.55 }}>
            The reviewed information did not establish whether these options have condition-specific research. Verify before relying on them.
          </p>
          <div style={{ display: 'grid', gap: '0.85rem' }}>
            {evidenceStatusUnknown.map((c, i) => (
              <CandidateCard key={`rd-unknown-${i}`} c={c} rank={i + 1} audience={audience} conditionLabel={cond} allowedUrls={reportAllowedUrls} />
            ))}
          </div>
        </div>
      )}

      {/* SECTION 2 — researched for condition, not FDA-approved */}
      {researchedNotApproved.length > 0 && (
        <div style={panelStyle}>
          <h3 style={{ margin: '0 0 0.35rem', color: theme.accent, fontSize: '1.05rem', display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
            <Flask size={18} />
            Researched, Not Yet FDA-Approved for {cond}
            <span style={{ color: theme.textDim, fontWeight: 500, fontSize: '0.85rem' }}>({researchedNotApproved.length})</span>
          </h3>
          <p style={{ margin: '0 0 0.85rem', color: theme.textDim, fontSize: '0.86rem', lineHeight: 1.55 }}>
            These drugs and supplements <strong style={{ color: theme.text }}>have been researched for {cond}</strong>
            {' '}(lab, animal, or early human studies) but are <strong style={{ color: theme.text }}>not FDA-approved</strong> for it.
            Each card links to that research. Already-approved treatments appear only under Approved Treatments — not here.
          </p>
          <div style={{ display: 'grid', gap: '0.85rem' }}>
            {researchedNotApproved.map((c, i) => (
              <CandidateCard
                key={`rd-rna-${i}`}
                c={c}
                rank={i + 1}
                audience={audience}
                conditionLabel={cond}
                allowedUrls={reportAllowedUrls}
              />
            ))}
          </div>
        </div>
      )}

      {(candidates.length > 0 || combos.length > 0) && (
        <div style={panelStyle}>
          <h3 style={{ margin: '0 0 0.35rem', color: theme.accent, fontSize: '1.05rem' }}>
            Combinations studied for this condition ({combos.length})
          </h3>
          <p style={{ margin: '0 0 0.75rem', color: theme.textDim, fontSize: '0.86rem', lineHeight: 1.55 }}>
            {combos.length
              ? 'Each combination below has a cited source that studied the exact combination for this condition. This does not predict benefit.'
              : 'No evidence-supported combination was identified in this search.'}
          </p>
          <div style={{ display: 'grid', gap: '0.85rem' }}>
            {combos.map((c, i) => (
              <ComboCard key={`combo-${i}`} c={c} rank={i + 1} allowedUrls={reportAllowedUrls} />
            ))}
          </div>
        </div>
      )}

      <div style={panelStyle}>
        <h3 style={{ marginTop: 0, color: theme.accent, fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Database size={18} /> Ask a follow-up question (uses your profile and chosen report style)
        </h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginBottom: '0.75rem' }}>
          {quickPrompts.map((p, i) => (
            <button key={i} style={btn('ghost')} onClick={() => setUserQuery(p)}>
              {p.length > 70 ? p.slice(0, 67) + '…' : p}
            </button>
          ))}
        </div>
        <div aria-live="polite" aria-relevant="additions" style={{ maxHeight: 360, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '0.75rem' }}>
          {chatHistory.map((m, i) => (
            <div key={i} style={{
              padding: '0.75rem', borderRadius: 8, maxWidth: '85%',
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              background: m.role === 'user' ? theme.accentSoft : theme.panel,
              border: `1px solid ${m.role === 'user' ? theme.accentEdge : theme.border}`
            }}>
              <div style={{ fontSize: '0.75rem', color: theme.accent, fontWeight: 600, marginBottom: 4 }}>
                {m.role === 'user' ? 'You' : 'Assistant'}
              </div>
              {m.role === 'user'
                ? <div style={{ whiteSpace: 'pre-wrap', fontSize: '0.9rem', lineHeight: 1.55 }}>{m.content}</div>
                : <Markdown text={m.content} />}
            </div>
          ))}
          {busy === 'chat' && (
            <div style={{
              padding: '0.75rem', borderRadius: 8, maxWidth: '85%', alignSelf: 'flex-start',
              background: theme.panel, border: `1px solid ${theme.border}`,
              display: 'flex', alignItems: 'center', gap: '0.5rem', color: theme.textDim, fontSize: '0.85rem'
            }}>
              <Loader size={14} className="spin" />
              <span>Working… finding trials and research, and putting together a summary…</span>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input aria-label="Ask a follow-up question" value={userQuery} onChange={e => setUserQuery(e.target.value)}
            placeholder={patient.condition ? `Ask about ${patient.condition}… or type a new disease to switch.` : "Type a disease to research (e.g. 'RP', 'LADA', 'Retinitis Pigmentosa') or ask a question."}
            onKeyDown={e => { if (e.key === 'Enter' && !busy && userQuery.trim()) { e.preventDefault(); sendChat(); } }}
            style={{ ...inputStyle, flex: 1 }} />
          <button style={btn('primary', !!busy || !userQuery.trim())}
            disabled={!!busy || !userQuery.trim()} onClick={sendChat}>
            {busy === 'chat' ? <Loader size={16} className="spin" /> : <Search size={16} />} Send
          </button>
        </div>
        <p style={{ margin: '0.65rem 0 0', fontSize: '0.72rem', color: theme.textDim, lineHeight: 1.45 }}>
          {CHAT_SESSION_FOOTNOTE}
        </p>
      </div>
    </div>
  );
};

const trialOrderingBreakdown = (s) => {
  const phase = (Array.isArray(s?.phases) ? s.phases : []).join(',');
  const STATUS = String(s.status || '').toUpperCase();
  const accessAvailable = s.acceptingNewPatients === true || STATUS === 'AVAILABLE';
  const chunks = [];
  if (s.relevanceReason) {
    chunks.push({
      label: s.relevanceLabel || 'Condition match',
      value: '',
      color: s.relevanceScore >= 15 ? theme.green : s.relevanceScore < 0 ? theme.red : theme.yellow,
      why: s.relevanceReason
    });
  }
  if (phase.includes('PHASE3')) chunks.push({ label: 'Later-stage study', value: '', color: theme.green,
    why: 'Phase 3 usually studies outcomes in a larger group. Stage alone does not predict benefit for an individual.' });
  else if (phase.includes('PHASE2')) chunks.push({ label: 'Mid-stage study', value: '', color: theme.green,
    why: 'Phase 2 studies treatment effects and safety in people, but results may remain uncertain.' });
  else if (phase.includes('PHASE1')) chunks.push({ label: 'Early-stage study', value: '', color: theme.yellow,
    why: 'Phase 1 mainly studies safety, dose, and feasibility; it does not establish likely benefit.' });
  if (s.acceptingNewPatients) chunks.push({ label: 'Accepting inquiries', value: '', color: theme.green,
    why: 'A site is accepting inquiries. The study team must still determine eligibility.' });
  if (s.hasPlacebo === false) chunks.push({ label: 'No placebo arm listed', value: '', color: theme.textDim,
    why: 'The registry record does not list a placebo arm. This is a design description, not a quality or benefit rating.' });
  if (accessAvailable && s.designations?.hasOpenLabelExtension) chunks.push({ label: 'Available extension record', value: '', color: theme.green,
    why: 'This record is flagged as an Open-Label Extension and its structured status is currently available. Confirm eligibility with the study team.' });
  if (accessAvailable && s.isExpandedAccessStudy) chunks.push({ label: 'Available expanded-access record', value: '', color: theme.green,
    why: 'This Expanded Access record has a currently available structured status. Confirm access terms with the study team.' });
  if (s.oversight?.oversightHasDMC) chunks.push({ label: 'Independent monitoring listed', value: '', color: theme.green,
    why: 'An independent team monitors safety and can stop the study early if needed.' });
  if (s.hasTopCenter) chunks.push({ label: 'At a major medical center', value: '', color: theme.green,
    why: 'This study is listed at one or more major academic/research medical centers. This is a facility signal, not a rating of this specific study’s quality or your likely benefit.' });
  if (['COMPLETED'].includes(STATUS)) chunks.push({ label: 'Completed', value: '', color: theme.textDim,
    why: 'This study has finished — you cannot join it. Ranked below trials still taking patients.' });
  else if (['TERMINATED', 'WITHDRAWN', 'SUSPENDED'].includes(STATUS)) chunks.push({ label: 'Stopped / closed', value: '', color: theme.red,
    why: 'This study was stopped or withdrawn — you cannot join it. Ranked below trials still taking patients.' });
  else if (STATUS === 'ACTIVE_NOT_RECRUITING') chunks.push({ label: 'Closed to new patients', value: '', color: theme.yellow,
    why: 'The study is ongoing but no longer signing up new participants.' });
  if (s.stoppedNegative && s.caution) chunks.push({ label: 'Stopped / negative evidence', value: '', color: theme.red, why: s.caution });
  return chunks;
};

// Registry enums that don't survive naive underscore-splitting: "PHASE1"
// became "Phase1" and "NA" became "Na". Explicit spellings first, then the
// generic path for anything not listed.
const REGISTRY_VALUE_LABELS = {
  NA: 'Not applicable',
  EARLY_PHASE1: 'Early phase 1',
  PHASE1: 'Phase 1',
  PHASE2: 'Phase 2',
  PHASE3: 'Phase 3',
  PHASE4: 'Phase 4',
  ACTIVE_NOT_RECRUITING: 'Active, not recruiting',
  NOT_YET_RECRUITING: 'Not yet recruiting',
  ENROLLING_BY_INVITATION: 'Enrolling by invitation',
  NO_LONGER_AVAILABLE: 'No longer available',
  APPROVED_FOR_MARKETING: 'Approved for marketing',
  TEMPORARILY_NOT_AVAILABLE: 'Temporarily not available',
  WITHHELD: 'Withheld',
  UNKNOWN: 'Unknown status'
};
const humanizeRegistryValue = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const key = raw.toUpperCase().replace(/\s+/g, '_');
  if (REGISTRY_VALUE_LABELS[key]) return REGISTRY_VALUE_LABELS[key];
  return raw
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b(\w)/g, (letter) => letter.toUpperCase())
    .replace(/\bPhase\s*(\d)/gi, 'Phase $1');
};

const TrialScoreExplainer = ({ trial, onClose }) => {
  if (!trial) return null;
  const chunks = trialOrderingBreakdown(trial);
  const trialUrl = exactClinicalTrialUrl(trial);
  return (
    <div id="mrt-trial-why-panel" style={{
      ...panelStyle,
      borderLeft: `4px solid ${theme.accent}`,
      marginBottom: '0.75rem'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '0.72rem', fontWeight: 700, color: theme.accent, textTransform: 'uppercase', letterSpacing: 0.4 }}>
            How was this ranking calculated?
          </div>
          <div style={{ fontWeight: 700, color: theme.text, marginTop: 4, lineHeight: 1.35 }}>
            {trial.briefTitle}
          </div>
          <div style={{ fontSize: '0.78rem', color: theme.textDim, marginTop: 2 }}>
            {trial.nctId} · Ordered by current access and study-stage attributes
            {trial.relevanceLabel && <> · Match: <strong style={{ color: theme.text }}>{trial.relevanceLabel}</strong></>}
          </div>
        </div>
        <button type="button" onClick={onClose} style={{ ...btn('ghost', false), padding: '0.35rem 0.65rem', fontSize: '0.78rem' }}>Close</button>
      </div>
      <div style={{ marginTop: '0.85rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {chunks.map((c, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'flex-start', gap: '0.6rem',
            padding: '0.5rem 0.65rem', borderRadius: 8,
            border: `1px solid ${c.color}44`, background: `${c.color}10`
          }}>
            <span style={{
              flex: '0 0 auto', minWidth: 110, textAlign: 'center',
              padding: '0.18rem 0.5rem', borderRadius: 999,
              border: `1px solid ${c.color}77`, color: c.color, background: `${c.color}20`,
              fontSize: '0.74rem', fontWeight: 700
            }}>
              {c.label}
            </span>
            <span style={{ fontSize: '0.84rem', color: theme.text, lineHeight: 1.5 }}>{c.why}</span>
          </div>
        ))}
      </div>
      <p style={{ marginTop: '0.75rem', marginBottom: 0, fontSize: '0.76rem', color: theme.textDim, lineHeight: 1.45 }}>
        These attributes determine list order. They do not predict treatment benefit or personal eligibility.
      </p>
      {trialUrl && (
        <div style={{ marginTop: '0.6rem' }}>
          <a href={trialUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open ${trial.nctId} on ClinicalTrials.gov`} style={{ color: theme.accent, fontWeight: 600, fontSize: '0.85rem' }}>
            Open on ClinicalTrials.gov ↗
          </a>
        </div>
      )}
    </div>
  );
};

const TrialsTable = ({ data }) => {
  const [sortMode, setSortMode] = useState('ordering');
  const [whyTrial, setWhyTrial] = useState(null);
  const phaseRank = (s) => {
    const p = (s.phases || []).join(',');
    if (p.includes('PHASE3')) return 4;
    if (p.includes('PHASE2')) return 3;
    if (p.includes('PHASE1')) return 2;
    return 1;
  };
  const efficacyProxyScore = (s) => {
    let n = 0;
    n += phaseRank(s) * 30;
    if (s.hasPlacebo === false) n += 15;
    if (s.acceptingNewPatients) n += 10;
    if (s.oversight?.oversightHasDMC) n += 6;
    return n;
  };
  // Condition relevance leads every sort mode. Without this the client threw
  // away the server's relevance ranking entirely, so a loosely-related study
  // could sit at the top of the list purely on study stage.
  const relevanceTier = (s) => {
    const score = s.relevanceScore ?? 0;
    if (score >= 45) return 3;
    if (score >= 18) return 2;
    if (score >= 8) return 1;
    return 0;
  };
  const rows = normalizeTrialStudies(data?.studies).sort((a, b) => {
    const tierDiff = relevanceTier(b) - relevanceTier(a);
    if (tierDiff !== 0) return tierDiff;
    if (sortMode === 'efficacy') return efficacyProxyScore(b) - efficacyProxyScore(a);
    if (sortMode === 'access') {
      const aScore = (a.isExpandedAccessStudy ? 3 : 0) + (a.designations?.hasOpenLabelExtension ? 2 : 0) + (a.designations?.hasPostTrialAccess ? 1 : 0) + (a.acceptingNewPatients ? 2 : 0);
      const bScore = (b.isExpandedAccessStudy ? 3 : 0) + (b.designations?.hasOpenLabelExtension ? 2 : 0) + (b.designations?.hasPostTrialAccess ? 1 : 0) + (b.acceptingNewPatients ? 2 : 0);
      return bScore - aScore;
    }
    return (b.accessStudyStageOrder ?? b.promiseScore ?? 0) - (a.accessStudyStageOrder ?? a.promiseScore ?? 0);
  });
  const matchColor = (label) => {
    if (label === 'strong match') return theme.green;
    if (label === 'likely match') return theme.accent;
    if (label === 'weak match' || label === 'unlikely match') return theme.yellow;
    if (label === 'wrong disease') return theme.red;
    return theme.textDim;
  };
  const eligibilitySummary = (study) => {
    const assessment = study.eligibilityAssessment;
    const unknown = [...new Set(
      (assessment?.checks || [])
        .filter((check) => check?.status === 'unknown')
        .map((check) => check.reason)
        .filter(Boolean)
    )];
    const statusLabels = {
      unknown: 'Eligibility unknown',
      'hard-mismatch': 'Likely not eligible based on provided facts',
      'criteria-unavailable': 'Criteria unavailable',
      'criteria-unchecked': 'Eligibility not fully checked'
    };
    return {
      label: statusLabels[assessment?.status] || 'Eligibility not assessed',
      unknown: unknown.length
        ? unknown
        : [assessment?.caution || 'Patient-specific facts needed to determine eligibility were not provided.']
    };
  };
  return (
  <div style={panelStyle}>
    <TrialScoreExplainer trial={whyTrial} onClose={() => setWhyTrial(null)} />
      <h3 style={{ marginTop: 0, color: theme.accent, fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
      First {Math.min(TRIAL_ROW_DISPLAY_LIMIT, rows.length)} studies · {Number.isFinite(Number(data?.total)) ? Number(data.total) : rows.length} matched your search
    </h3>
    {(data.breakdown?.droppedWrongCondition || 0) > 0 && (
      <p style={{ margin: '0 0 0.65rem', fontSize: '0.82rem', color: theme.textDim, lineHeight: 1.45 }}>
        We also found {data.breakdown.droppedWrongCondition} other studies on ClinicalTrials.gov that were
        for a <strong>different condition</strong> (for example, a drug-name search that pulled in unrelated diseases).
        Those are hidden so this list stays focused on {data.query?.condition || 'your search'}.
      </p>
    )}
    <p style={{ margin: '0 0 0.65rem', fontSize: '0.82rem', color: theme.textDim, lineHeight: 1.45 }}>
      Select <strong>How was this ranked?</strong> on any row to see which factors affected its position.
    </p>
    <p role="note" style={{ margin: '0 0 0.65rem', fontSize: '0.84rem', color: theme.yellow, lineHeight: 1.5 }}>
      <strong>Important:</strong> A study marked recruiting or accepting new patients does not mean you are personally eligible. The study team must review all criteria and your medical information.
    </p>
    <div style={{ marginBottom: '0.65rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
      <label htmlFor="mrt-trial-sort" style={{ fontSize: '0.78rem', color: theme.textDim }}>Sort by:</label>
      <select
        id="mrt-trial-sort"
        value={sortMode}
        onChange={(e) => setSortMode(e.target.value)}
        style={{ ...inputStyle, width: 'auto', padding: '0.3rem 0.5rem', fontSize: '0.78rem' }}
        title="Choose ranking emphasis"
      >
        <option value="ordering">Current access and study stage</option>
        <option value="efficacy">Study phase and design</option>
        <option value="access">Current access indicators</option>
      </select>
    </div>
    <div className="mrt-table-scroll" tabIndex="0" aria-label="Clinical trials table, scroll horizontally if needed">
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
        <thead>
          <tr style={{ background: theme.accentSoft, borderBottom: `2px solid ${theme.accent}` }}>
            {['Study','Study stage','Study status','Accepting inquiries','Eligibility review','Placebo listed','Access notes','Countries','Monitoring','Why this order',''].map(h => (
              <th key={h} style={{ padding: '0.6rem', textAlign: 'left', color: theme.accent, fontWeight: 700 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, TRIAL_ROW_DISPLAY_LIMIT).map((s, idx) => {
            const rowKey = s.nctId || `${s.briefTitle || 'trial'}-${idx}`;
            const isSelected = whyTrial?.nctId === s.nctId;
            const eligibility = eligibilitySummary(s);
            const trialUrl = exactClinicalTrialUrl(s);
            return (
                <tr key={rowKey} style={{
                  borderBottom: `1px solid ${theme.border}`,
                  verticalAlign: 'top',
                  background: isSelected ? `${theme.accent}12` : 'transparent'
                }}>
                  <td style={{ padding: '0.6rem', maxWidth: 360 }}>
                    <div style={{ color: theme.accent, fontWeight: 600 }}>{s.briefTitle || s.officialTitle || s.title || 'Study title not listed'}</div>
                    <div style={{ color: theme.textDim, fontSize: '0.75rem' }}>{s.nctId} · {s.sponsor || ''}</div>
                    {s.relevanceLabel && (
                      <span style={{
                        display: 'inline-block', marginTop: 4, fontSize: '0.68rem', fontWeight: 700,
                        padding: '0.12rem 0.4rem', borderRadius: 999,
                        color: matchColor(s.relevanceLabel),
                        border: `1px solid ${matchColor(s.relevanceLabel)}55`,
                        background: `${matchColor(s.relevanceLabel)}12`
                      }}>
                        {s.relevanceLabel}
                      </span>
                    )}
                    {s.stoppedNegative && s.caution && (
                      <div title={s.caution} style={{
                        marginTop: 4, fontSize: '0.68rem', fontWeight: 700,
                        padding: '0.12rem 0.4rem', borderRadius: 6,
                        color: theme.red, border: `1px solid ${theme.red}55`, background: `${theme.red}12`,
                        display: 'inline-block', cursor: 'help'
                      }}>
                        ⚠ Stopped / negative
                      </div>
                    )}
                  </td>
                  <td style={{ padding: '0.6rem' }}>{(s.phases || []).map(humanizeRegistryValue).join(', ') || 'Not listed'}</td>
                  <td style={{ padding: '0.6rem' }}>{humanizeRegistryValue(s.status) || 'Not listed'}</td>
                  <td style={{ padding: '0.6rem', color: s.acceptingNewPatients === true ? theme.green : theme.textDim }}>
                    {trialBooleanLabel(s.acceptingNewPatients, { unknown: 'Unknown' })}
                  </td>
                  <td style={{ padding: '0.6rem', minWidth: 210, fontSize: '0.75rem' }}>
                    <strong style={{ color: theme.yellow }}>{eligibility.label}</strong>
                    <div style={{ marginTop: 4, color: theme.textDim }}>
                      <strong>Unknown or missing facts:</strong>
                      <ul style={{ margin: '0.2rem 0 0', paddingLeft: '1.1rem' }}>
                        {eligibility.unknown.map((fact, factIndex) => (
                          <li key={`${rowKey}-eligibility-${factIndex}`}>{fact}</li>
                        ))}
                      </ul>
                    </div>
                  </td>
                  <td style={{ padding: '0.6rem', color: s.hasPlacebo === true ? theme.yellow : s.hasPlacebo === false ? theme.green : theme.textDim }}>
                    {trialBooleanLabel(s.hasPlacebo, { unknown: 'Not listed' })}
                  </td>
                  <td style={{ padding: '0.6rem', fontSize: '0.75rem' }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                      {s.designations?.hasOpenLabelExtension && <span title="The registry record is flagged as an open-label extension. Check its current status and eligibility criteria." style={{ padding: '0.12rem 0.35rem', borderRadius: 999, border: `1px solid ${theme.accent}55`, color: theme.accent }}>Open-label extension</span>}
                      {s.isExpandedAccessStudy && <span title="CT.gov Expanded Access program — get the drug outside a normal trial." style={{ padding: '0.12rem 0.35rem', borderRadius: 999, border: `1px solid ${theme.green}55`, color: theme.green }}>Expanded Access</span>}
                      {s.designations?.hasPostTrialAccess && <span title="The structured record mentions post-trial access. Check its current status and terms." style={{ padding: '0.12rem 0.35rem', borderRadius: 999, border: `1px solid ${theme.yellow}55`, color: theme.yellow }}>Post-trial access noted</span>}
                      {s.designations?.hasPayToAccess && <span title="You may have to pay to get the drug." style={{ padding: '0.12rem 0.35rem', borderRadius: 999, border: `1px solid ${theme.red}55`, color: theme.red }}>You may have to pay</span>}
                      {!s.designations?.hasOpenLabelExtension && !s.isExpandedAccessStudy && !s.designations?.hasPostTrialAccess && !s.designations?.hasPayToAccess && <span>—</span>}
                    </div>
                  </td>
                  <td style={{ padding: '0.6rem', fontSize: '0.75rem' }}>{(s.countries || []).join(', ') || '—'}</td>
                  <td style={{ padding: '0.6rem', fontSize: '0.75rem' }}>
                    {s.oversight?.oversightHasDMC ? <span title="An independent safety team watches the study and can stop it early if something looks unsafe.">Safety team ✓ </span> : ''}{s.oversight?.fdaRegulatedDrug ? <span title="The drug is made under FDA rules.">FDA-checked drug ✓</span> : ''}
                  </td>
                  <td style={{ padding: '0.6rem', fontWeight: 700 }}>
                    <button
                      type="button"
                      onClick={() => {
                        setWhyTrial(isSelected ? null : s);
                        if (!isSelected) {
                          setTimeout(() => {
                            document.getElementById('mrt-trial-why-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                          }, 50);
                        }
                      }}
                      style={{
                        marginTop: 4,
                        background: isSelected ? `${theme.accent}22` : 'transparent',
                        border: `1px solid ${isSelected ? theme.accent : theme.border}`,
                        color: isSelected ? theme.accent : theme.textDim,
                        borderRadius: 6, padding: '0.15rem 0.45rem',
                        fontSize: '0.72rem', cursor: 'pointer', fontWeight: 600
                      }}
                    >
                      {isSelected ? 'Hide ranking details' : 'How was this ranked?'}
                    </button>
                  </td>
                  <td style={{ padding: '0.6rem' }}>
                    {trialUrl
                      ? <a href={trialUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.8rem' }}>
                          Open {s.nctId} <ExternalLink size={12} />
                        </a>
                      : '—'}
                  </td>
                </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  </div>
);
};

const RankedTrialsForPatient = ({ blocks }) => (
  <div style={panelStyle}>
    <h3 style={{ marginTop: 0, color: theme.accent, fontSize: '1rem' }}>
      Studies reviewed for this patient
    </h3>
    <div style={{ display: 'grid', gap: '0.75rem' }}>
      {blocks.map((b, i) => (
        <div key={i} style={{
          padding: '0.9rem', background: theme.panel,
          borderRadius: 8, border: `1px solid ${theme.border}`
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
            <div style={{ fontWeight: 600, color: theme.accent }}>{b.trial}</div>
            <div style={{ fontSize: '0.8rem', color: theme.textDim }}>Study-team eligibility review required</div>
          </div>
          <div style={{ fontSize: '0.8rem', color: theme.textDim, marginTop: 4 }}>
            {b.nct} · {humanizeRegistryValue(b.phase)} · {humanizeRegistryValue(b.status)} · {b.country}
          </div>
          <div style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>{b.summary}</div>
          {b.interactions && (
            <div style={{ fontSize: '0.8rem', marginTop: '0.4rem', color: theme.yellow }}>
              ⚠ Interactions: {b.interactions}
            </div>
          )}
          {exactClinicalTrialUrl({ ...b, nctId: b.nct }) && (
            <div style={{ marginTop: '0.5rem' }}>
              <a href={exactClinicalTrialUrl({ ...b, nctId: b.nct })} target="_blank" rel="noopener noreferrer" aria-label={`Open ${b.nct} on ClinicalTrials.gov`} style={{ fontSize: '0.85rem' }}>
                Open on ClinicalTrials.gov ↗
              </a>
            </div>
          )}
        </div>
      ))}
    </div>
  </div>
);

/* ==================== Repurpose cards (Research tab) ==================== */
// Expandable disclosure for a titled section on the candidate card.
const Disclosure = ({ title, icon, color, children, defaultOpen = false }) => {
  const [open, setOpen] = useState(defaultOpen);
  const accent = color || theme.accent;
  return (
    <div style={{
      marginTop: '0.5rem',
      borderRadius: 8,
      border: `1px solid ${accent}33`,
      background: `${accent}08`,
      overflow: 'hidden'
    }}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(v => !v)} style={{
        width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: 'transparent', border: 'none', cursor: 'pointer',
        padding: '0.55rem 0.8rem',
        color: accent, fontSize: '0.82rem', fontWeight: 700, letterSpacing: 0.3
      }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
          {icon}{title}
        </span>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open && (
        <div style={{
          padding: '0 0.8rem 0.8rem',
          fontSize: '0.88rem', lineHeight: 1.6, color: theme.text,
          whiteSpace: 'pre-wrap'
        }}>
          {children}
        </div>
      )}
    </div>
  );
};

const RankBadge = ({ rank }) => (
  <div style={{
    width: 40, height: 40, borderRadius: 10,
    background: `linear-gradient(135deg, ${theme.accent}aa, ${theme.accent}55)`,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontWeight: 800, fontSize: '1.1rem', color: '#ffffff',
    boxShadow: `0 2px 10px ${theme.accent}33`,
    fontVariantNumeric: 'tabular-nums'
  }}>
    #{rank}
  </div>
);

// Individual repurposing-candidate card. One per drug/supplement.
const TREATMENT_LEAK_FIELDS = ['treatment', 'fda_status', 'provider', 'length_frequency', 'references', 'risks', 'interactions', 'efficacy', 'safety_note'];
const TreatmentCard = ({ t: rawT, rank, allowedUrls = null }) => {
  const { card: t, leaks } = useMemo(
    () => auditAndScrubCard(rawT, TREATMENT_LEAK_FIELDS, { kind: 'approved-treatment', label: rawT?.treatment }),
    [rawT]
  );
  const refText = linkifyMedicalIds(t.references || '');
  const cardLinks = useMemo(
    () => filterAllowedReportLinks(extractLinksFromText(refText), allowedUrls),
    [refText, allowedUrls]
  );
  const fda = String(t.fda_status || '').toLowerCase();
  const notApproved = fda && !fda.startsWith('approved');
  const exactLabelLink = cardLinks.find((link) =>
    /dailymed\.nlm\.nih\.gov\/dailymed\/drugInfo\.cfm\?setid=/i.test(link.url)
  );
  return (
    <div style={{
      padding: '1rem 1.1rem', background: theme.panel, borderRadius: 12,
      border: `1px solid ${notApproved ? theme.yellow + '88' : theme.border}`,
      position: 'relative', overflow: 'hidden'
    }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 3,
        background: `linear-gradient(90deg, ${theme.green}, ${theme.accent})`
      }} />
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.9rem' }}>
        <RankBadge rank={rank} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: '1.15rem', color: theme.text }}>
            <InlineTitle text={t.treatment || '(unnamed treatment)'} allowedUrls={allowedUrls} />
          </div>
          <FormatWarning leaks={leaks} />
          {t.fda_status && (
            <div style={{ fontSize: '0.78rem', color: notApproved ? theme.yellow : theme.green, marginTop: 4, fontWeight: 600 }}>
              <InlineMD text={t.fda_status} allowedUrls={allowedUrls} />
              {exactLabelLink && (
                <>
                  {' · '}
                  <a
                    href={exactLabelLink.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: theme.accent }}
                  >
                    FDA label ↗
                  </a>
                </>
              )}
            </div>
          )}
          {t.provider && (
            <div style={{ fontSize: '0.82rem', color: theme.textDim, marginTop: 4 }}><InlineMD text={t.provider} allowedUrls={allowedUrls} /></div>
          )}
          {t.length_frequency && (
            <div style={{ marginTop: '0.55rem', fontSize: '0.86rem', lineHeight: 1.5 }}>
              <strong style={{ color: theme.text }}>Dose and schedule: </strong>
              <InlineMD text={t.length_frequency} allowedUrls={allowedUrls} />
            </div>
          )}
          {t.efficacy && (
            <div style={{ marginTop: '0.55rem', fontSize: '0.86rem', lineHeight: 1.5 }}>
              <strong style={{ color: theme.text }}>What studies found: </strong>
              <InlineMD text={t.efficacy} allowedUrls={allowedUrls} />
            </div>
          )}
          {(t.safety_band || t.safety_note || t.safety) && (
            <div style={{ marginTop: '0.55rem', fontSize: '0.86rem', lineHeight: 1.5 }}>
              <strong style={{ color: theme.text }}>Safety concern: </strong>
              {t.safety_band && <span style={{ color: bandColor(t.safety_band), fontWeight: 700 }}>{t.safety_band}. </span>}
              <InlineMD text={t.safety_note || t.safety} allowedUrls={allowedUrls} />
            </div>
          )}
          {cardLinks.length > 0 ? (
            <div style={{ marginTop: '0.55rem' }}>
              <div style={{ fontSize: '0.72rem', fontWeight: 700, color: theme.accent, textTransform: 'uppercase', marginBottom: 4 }}>
                Sources ↗
              </div>
              {cardLinks.slice(0, 4).map((l, i) => (
                <a key={i} href={l.url} target="_blank" rel="noopener noreferrer"
                  style={{ display: 'block', fontSize: '0.84rem', color: theme.accent, marginBottom: 4 }}>
                  {linkLabelText(l.label)} ↗
                </a>
              ))}
            </div>
          ) : refText ? (
            <div style={{ marginTop: '0.5rem', fontSize: '0.84rem' }}><Markdown text={refText} allowedUrls={allowedUrls} /></div>
          ) : null}
        </div>
      </div>
      {t.risks && (
        <div style={{ marginTop: '0.6rem', fontSize: '0.82rem', color: theme.textDim, lineHeight: 1.5 }}>
          <strong style={{ color: theme.text }}>Risks: </strong><InlineMD text={t.risks} allowedUrls={allowedUrls} />
        </div>
      )}
      {t.interactions && (
        <div style={{ marginTop: '0.6rem', padding: '0.55rem 0.65rem', borderRadius: 7, border: `1px solid ${theme.yellow}55`, background: `${theme.yellow}10`, fontSize: '0.82rem', lineHeight: 1.5 }}>
          <strong style={{ color: theme.yellow }}>Medication interactions: </strong><InlineMD text={t.interactions} allowedUrls={allowedUrls} />
        </div>
      )}
    </div>
  );
};

const COMBO_LEAK_FIELDS = ['combo', 'rationale', 'evidence_tier', 'supporting_evidence', 'interaction_risk', 'patient_specific_risks', 'confidence', 'how_to_discuss_with_doctor', 'references'];
const ComboCard = ({ c: rawC, rank, allowedUrls = null }) => {
  const { card: c, leaks } = useMemo(
    () => auditAndScrubCard(rawC, COMBO_LEAK_FIELDS, { kind: 'combination', label: rawC?.combo }),
    [rawC]
  );
  const linkText = linkifyMedicalIds([c.references, c.supporting_evidence].filter(Boolean).join('\n'));
  const cardLinks = useMemo(
    () => filterAllowedReportLinks(extractLinksFromText(linkText), allowedUrls),
    [linkText, allowedUrls]
  );
  return (
    <div style={{
      padding: '1rem', background: theme.panel, borderRadius: 12,
      border: `1px dashed ${theme.accent}66`
    }}>
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
        <RankBadge rank={rank} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: '1.05rem', color: theme.text }}><InlineTitle text={c.combo || 'Combination'} allowedUrls={allowedUrls} /></div>
          <FormatWarning leaks={leaks} />
          {c.evidence_tier && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: 6 }}>
              <EvidenceStrengthBadge value={c.evidence_tier} />
            </div>
          )}
          {c.rationale && <div style={{ marginTop: 8, fontSize: '0.88rem', lineHeight: 1.55 }}><InlineMD text={c.rationale} allowedUrls={allowedUrls} /></div>}
          {c.interaction_risk && (
            <div style={{ marginTop: 8, fontSize: '0.82rem', color: theme.yellow }}>
              <strong>Interaction risk: </strong><InlineMD text={c.interaction_risk} allowedUrls={allowedUrls} />
            </div>
          )}
          {c.supporting_evidence && (
            <Disclosure title="What the research says" icon={<Database size={13} />} color={theme.green}>
              <Markdown text={c.supporting_evidence} allowedUrls={allowedUrls} />
              <SourceLinks text={c.supporting_evidence} label="Links from evidence" allowedUrls={allowedUrls} />
            </Disclosure>
          )}
          {c.patient_specific_risks && (
            <Disclosure
              title="Risks for this patient specifically"
              icon={<AlertTriangle size={13} />}
              color={theme.yellow}
              defaultOpen={/high|moderate|interaction/i.test(String(c.interaction_risk))}
            >
              <InlineMD text={c.patient_specific_risks} allowedUrls={allowedUrls} />
            </Disclosure>
          )}
          {c.how_to_discuss_with_doctor && (
            <Disclosure title="Questions to ask your doctor" icon={<MessageCircle size={13} />} color={theme.green}>
              <InlineMD text={c.how_to_discuss_with_doctor} allowedUrls={allowedUrls} />
            </Disclosure>
          )}
          {cardLinks.length > 0 && (
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {cardLinks.slice(0, 3).map((l, i) => (
                <a key={i} href={l.url} target="_blank" rel="noopener noreferrer"
                  style={{ fontSize: '0.82rem', color: theme.accent }}>{linkLabelText(l.label)} ↗</a>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const CANDIDATE_LEAK_FIELDS = ['candidate', 'item_kind', 'class', 'approved_for', 'what_it_does', 'why_for_this_condition', 'mechanism_target', 'repurpose_rationale', 'repurpose_section', 'evidence_strength', 'supporting_evidence', 'references', 'efficacy_hypothesis', 'safety', 'confidence', 'patient_specific_risks', 'how_to_discuss_with_doctor'];
const ItemKindBadge = ({ kind }) => {
  const isSupp = String(kind || '').toUpperCase() === 'SUPPLEMENT';
  const isSupportive = String(kind || '').toUpperCase() === 'SUPPORTIVE_CARE';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '0.2rem 0.55rem', borderRadius: 999, fontSize: '0.68rem',
      fontWeight: 800, letterSpacing: 0.4, textTransform: 'uppercase',
      border: `1px solid ${isSupp ? theme.green + '88' : theme.accent + '88'}`,
      background: isSupp ? `${theme.green}18` : `${theme.accent}18`,
      color: isSupp ? theme.green : theme.accent
    }}>
      {isSupportive ? 'Supportive / non-drug care' : isSupp ? 'Supplement' : 'Medication'}
    </span>
  );
};
const CandidateCard = ({ c: rawC, rank, highlightMechanistic, audience = 'layperson', conditionLabel = '', allowedUrls = null }) => {
  const { card: c, leaks } = useMemo(
    () => auditAndScrubCard(rawC, CANDIDATE_LEAK_FIELDS, { kind: 'repurposing-candidate', label: rawC?.candidate }),
    [rawC]
  );
  const section = resolveRepurposeSection(c, {
    condition: conditionLabel,
    hasCitation: candidateCarriesCitation(c)
  });
  const itemKind = resolveItemKind(c);
  const mechanistic = highlightMechanistic || section === 'no-condition-study-identified' || isMechanisticEvidence(c.evidence_strength);
  const lay = audience !== 'medical';
  const cond = conditionLabel || 'this condition';
  const allLinkText = linkifyMedicalIds(
    [c.references, c.supporting_evidence, c.repurpose_rationale].filter(Boolean).join('\n')
  );
  const cardLinks = useMemo(
    () => filterAllowedReportLinks(extractLinksFromText(allLinkText), allowedUrls),
    [allLinkText, allowedUrls]
  );
  const whyPlain = c.why_for_this_condition || c.repurpose_rationale;
  return (
    <div style={{
      padding: '1rem 1.1rem',
      background: theme.panel,
      borderRadius: 12,
      border: mechanistic ? `2px dashed ${theme.accent}88` : `1px solid ${theme.border}`,
      position: 'relative',
      overflow: 'hidden'
    }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 3,
        background: `linear-gradient(90deg, ${theme.accent}, ${c.confidence_band ? bandColor(c.confidence_band) : ratingColor(c.confidence_pct)})`
      }} />
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.9rem' }}>
        <RankBadge rank={rank} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '0.6rem' }}>
            <div style={{ fontWeight: 800, fontSize: '1.15rem', color: theme.text }}>
              <InlineTitle text={c.candidate || 'Idea awaiting a name'} allowedUrls={allowedUrls} />
            </div>
            <ItemKindBadge kind={itemKind} />
            {c.class && (
              <div style={{ fontSize: '0.78rem', color: theme.textDim, fontStyle: 'italic' }}>
                <InlineMD text={c.class} allowedUrls={allowedUrls} />
              </div>
            )}
          </div>
          <FormatWarning leaks={leaks} />
          {section === 'no-condition-study-identified' && (
            <div style={{
              marginTop: '0.55rem', padding: '0.55rem 0.65rem', borderRadius: 8,
              border: `1px dashed ${theme.accent}66`, background: `${theme.accent}10`,
              fontSize: '0.84rem', color: theme.text, lineHeight: 1.5
            }}>
              No condition-specific study identified in this search.
              The indirect rationale comes from other conditions or biological research and does not imply benefit. Discuss the evidence limits with your clinician.
            </div>
          )}
          {section === 'researched-not-approved' && (
            <div style={{
              marginTop: '0.55rem', padding: '0.55rem 0.65rem', borderRadius: 8,
              border: `1px solid ${theme.green}55`, background: `${theme.green}10`,
              fontSize: '0.84rem', color: theme.text, lineHeight: 1.5
            }}>
              Condition-specific research was identified, but this is not established as an FDA-approved medication for <strong>{cond}</strong>. The source shows the study stage and reported finding; it does not predict benefit.
            </div>
          )}
          {c.what_it_does && lay && (
            <div style={{
              marginTop: '0.55rem', padding: '0.65rem 0.75rem', borderRadius: 8,
              background: `${theme.accent}10`, border: `1px solid ${theme.accent}33`,
              fontSize: '0.92rem', lineHeight: 1.5, color: theme.text
            }}>
              <strong style={{ color: theme.accent, fontSize: '0.72rem', letterSpacing: 0.4, textTransform: 'uppercase' }}>
                What it is
              </strong>
              <div style={{ marginTop: 4 }}><InlineMD text={c.what_it_does} allowedUrls={allowedUrls} /></div>
            </div>
          )}
          {whyPlain && (
            <div style={{
              marginTop: '0.55rem', padding: '0.65rem 0.75rem', borderRadius: 8,
              background: `${theme.green}10`, border: `1px solid ${theme.green}33`,
              fontSize: '0.92rem', lineHeight: 1.55, color: theme.text
            }}>
              <strong style={{ color: theme.green, fontSize: '0.72rem', letterSpacing: 0.4, textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Lightbulb size={11} /> Why this option was searched
              </strong>
              <div style={{ marginTop: 4 }}>
                {c.why_for_this_condition
                  ? <InlineMD text={c.why_for_this_condition} allowedUrls={allowedUrls} />
                  : <Markdown text={String(c.repurpose_rationale).split('\n').slice(0, 3).join('\n')} allowedUrls={allowedUrls} />}
              </div>
            </div>
          )}
          {cardLinks.length > 0 ? (
            <div style={{
              marginTop: '0.55rem', padding: '0.55rem 0.65rem', borderRadius: 8,
              border: `1px solid ${theme.accent}44`, background: `${theme.accent}08`
            }}>
              <div style={{ fontSize: '0.72rem', fontWeight: 700, color: theme.accent, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>
                {section === 'no-condition-study-identified'
                  ? 'Source from another condition / how it works ↗'
                  : 'Research on this condition ↗'}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                {cardLinks.slice(0, 4).map((l, i) => (
                  <a key={i} href={l.url} target="_blank" rel="noopener noreferrer"
                    style={{ fontSize: '0.84rem', color: theme.accent, fontWeight: 600, lineHeight: 1.4 }}>
                    {linkLabelText(l.label)} ↗
                  </a>
                ))}
              </div>
            </div>
          ) : (
            <div style={{
              marginTop: '0.55rem', padding: '0.5rem 0.65rem', borderRadius: 8,
              border: `1px dashed ${theme.yellow}66`, background: `${theme.yellow}10`,
              fontSize: '0.78rem', color: theme.yellow, lineHeight: 1.45
            }}>
              {section === 'no-condition-study-identified'
                ? `No condition-specific study was identified in this search. This indirect rationale does not imply benefit.`
                : section === 'study-status-unclear'
                  ? 'The available information did not establish whether this option has condition-specific research. A clinician should verify before relying on it.'
                  : `Condition-specific research was described for ${cond}, but no working source link was available in this search. Do not rely on the claim until it is verified.`}
            </div>
          )}
          {c.approved_for && itemKind !== 'SUPPORTIVE_CARE' && (
            <div style={{ fontSize: '0.78rem', color: theme.textDim, marginTop: 2 }}>
              {lay ? 'Usually used for: ' : 'Currently approved for: '}
              <span style={{ color: theme.text }}><InlineMD text={c.approved_for} allowedUrls={allowedUrls} /></span>
            </div>
          )}
          {c.evidence_strength && evidenceTestedIn(c.evidence_strength, lay) && (
            <div style={{
              marginTop: '0.55rem', padding: '0.5rem 0.65rem', borderRadius: 8,
              border: `1px solid ${evidenceMeta(c.evidence_strength).color}55`,
              background: `${evidenceMeta(c.evidence_strength).color}12`,
              fontSize: '0.8rem', lineHeight: 1.45, color: theme.text,
              display: 'flex', alignItems: 'center', gap: 6
            }}>
              <Flask size={13} style={{ color: evidenceMeta(c.evidence_strength).color, flexShrink: 0 }} />
              <span><strong style={{ color: evidenceMeta(c.evidence_strength).color }}>Tested in:</strong> {evidenceTestedIn(c.evidence_strength, lay)}</span>
            </div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.55rem' }}>
            {c.evidence_strength && <EvidenceStrengthBadge value={c.evidence_strength} />}
            {c.mechanism_target && (
              <span title={lay ? 'Plain-language idea of how it might work' : 'Molecular target / pathway'} style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                padding: '0.25rem 0.65rem', borderRadius: 999, fontSize: '0.72rem',
                border: `1px solid ${theme.accent}55`, background: `${theme.accent}12`,
                color: theme.accent, fontWeight: 600
              }}>
                <Flask size={11} /> {lay ? 'Might work by: ' : ''}
                <InlineMD allowedUrls={allowedUrls} text={String(c.mechanism_target).length > (lay ? 100 : 80)
                  ? String(c.mechanism_target).slice(0, (lay ? 97 : 77)) + '…'
                  : c.mechanism_target} />
              </span>
            )}
          </div>
        </div>
      </div>

      {c.repurpose_rationale && c.why_for_this_condition && (
        <Disclosure
          title={lay ? 'Full reasoning' : 'Detailed rationale'}
          icon={<Lightbulb size={13} />}
          color={theme.accent}
        >
          <Markdown text={c.repurpose_rationale} allowedUrls={allowedUrls} />
        </Disclosure>
      )}
      {c.supporting_evidence && (
        <Disclosure
          title="What the research says"
          icon={<Database size={13} />}
          color={theme.green}
          defaultOpen={!mechanistic}
        >
          <Markdown text={c.supporting_evidence} allowedUrls={allowedUrls} />
          <SourceLinks text={c.supporting_evidence} label="Links from evidence" allowedUrls={allowedUrls} />
        </Disclosure>
      )}
      {c.patient_specific_risks && (
        <Disclosure
          title="Risks for this patient specifically"
          icon={<AlertTriangle size={13} />}
          color={theme.yellow}
          defaultOpen={/high|moderate|interaction|sedat|fall/i.test(String(c.patient_specific_risks))}
        >
          <InlineMD text={c.patient_specific_risks} allowedUrls={allowedUrls} />
        </Disclosure>
      )}
      {c.how_to_discuss_with_doctor && (
        <Disclosure
          title="Questions to ask your doctor"
          icon={<MessageCircle size={13} />}
          color={theme.green}
        >
          <InlineMD text={c.how_to_discuss_with_doctor} allowedUrls={allowedUrls} />
        </Disclosure>
      )}
    </div>
  );
};

/* ==================== References Tab ==================== */
// Two sections now:
//   1. The grounded evidence pack that was fed to Claude — with per-source
//      access-level badges (full-text / abstract / metadata-only).
//   2. The raw URLs Claude's narrative emitted — parsed from its text.
const RefsTab = ({ references, evidencePack, evidenceSummary, trialsData }) => {
  const referenceRows = Array.isArray(references) ? references : [];
  const evidenceRows = (Array.isArray(evidencePack) ? evidencePack : [])
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item));
  const allowedUrls = useMemo(
    () => buildAllowedUrlSet(trialsData, evidenceSummary || { topRanked: evidenceRows }),
    [trialsData, evidenceSummary, evidencePack]
  );
  const safeReferences = useMemo(
    () => filterAllowedReportLinks(referenceRows, allowedUrls),
    [references, allowedUrls]
  );
  const pubmedRefs = safeReferences.filter(r => r.url.includes('pubmed') || r.url.includes('doi.org'));
  const trialRefs = safeReferences.filter(r => r.url.includes('clinicaltrials.gov'));
  const otherRefs = safeReferences.filter(r => !pubmedRefs.includes(r) && !trialRefs.includes(r));
  const Section = ({ title, items }) => items.length === 0 ? null : (
    <div style={{ marginBottom: '1.25rem' }}>
      <h3 style={{ color: theme.accent, fontSize: '1rem', marginBottom: '0.5rem' }}>{title} ({items.length})</h3>
      <div style={{ display: 'grid', gap: '0.5rem' }}>
        {items.map((r, i) => (
          <div key={i} style={{
            padding: '0.6rem 0.75rem', background: theme.panel,
            borderRadius: 8, border: `1px solid ${theme.border}`
          }}>
            <a href={r.url} target="_blank" rel="noopener"
              style={{ fontSize: '0.88rem', wordBreak: 'break-all' }}>
              {r.quote || r.url}
            </a>
            {r.quote && <div style={{ fontSize: '0.85rem', fontStyle: 'italic', marginTop: '0.3rem', color: theme.textDim }}>
              “{r.quote}”
            </div>}
          </div>
        ))}
      </div>
    </div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={panelStyle}>
        <h2 style={{ margin: 0, color: theme.accent, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Book size={22} /> Sources
        </h2>
        <p style={{ color: theme.textDim, fontSize: '0.9rem' }}>
          Papers and labels used for this report. Open the link to read the original source.
        </p>
        {evidenceSummary?.accessBreakdown && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.75rem' }}>
            <AccessBadge level="full-text"     n={evidenceSummary.accessBreakdown['full-text']} />
            <AccessBadge level="abstract"      n={evidenceSummary.accessBreakdown['abstract']} />
            <AccessBadge level="metadata-only" n={evidenceSummary.accessBreakdown['metadata-only']} />
          </div>
        )}
      </div>

      {evidenceRows.length > 0 && (
        <div style={panelStyle}>
          <h3 style={{ marginTop: 0, color: theme.accent, fontSize: '1rem' }}>
            Sources used in this report ({evidenceRows.length})
          </h3>
          <div style={{ display: 'grid', gap: '0.5rem' }}>
            {evidenceRows.map((p, i) => {
              const url = p.pmcUrl || p.pubmedUrl || p.doiUrl || p.oaUrl || p.landingUrl || p.europePmcUrl || p.url
                || (p.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${String(p.pmid).replace(/\D/g, '')}/` : null)
                || (p.doi ? `https://doi.org/${String(p.doi).replace(/^https?:\/\/doi\.org\//i, '')}` : null);
              const safeUrl = allowedReportUrl(url, allowedUrls);
              const sourceText = typeof p.fullText === 'string'
                ? p.fullText
                : typeof p.abstract === 'string' ? p.abstract : '';
              const excerpt = sourceText.slice(0, 260);
              return (
                <div key={i} style={{
                  padding: '0.75rem', background: theme.panel,
                  borderRadius: 8, border: `1px solid ${theme.border}`
                }}>
                  <div style={{ fontWeight: 600, fontSize: '0.92rem' }}>
                    {typeof p.title === 'string' && p.title.trim() ? p.title : '(untitled)'}
                  </div>
                  <div style={{ fontSize: '0.78rem', color: theme.textDim, marginTop: 2 }}>
                    {p.journal || 'Journal'}{p.year ? ` · ${p.year}` : ''}
                    {typeof p.citedByCount === 'number' ? ` · cited ${p.citedByCount}×` : ''}
                  </div>
                  {excerpt && (
                    <div style={{
                      fontSize: '0.82rem', color: theme.text, marginTop: '0.4rem',
                      fontStyle: 'italic', lineHeight: 1.5
                    }}>
                      “{excerpt}{sourceText.length > 260 ? '…' : ''}”
                    </div>
                  )}
                  {safeUrl && (
                    <div style={{ marginTop: '0.4rem' }}>
                      <a href={safeUrl} target="_blank" rel="noopener noreferrer"
                         style={{ fontSize: '0.82rem', wordBreak: 'break-all' }}>
                        {safeUrl}
                      </a>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={panelStyle}>
        <h3 style={{ marginTop: 0, color: theme.accent, fontSize: '1rem' }}>
          Links from your report
        </h3>
        <p style={{ color: theme.textDim, fontSize: '0.85rem', marginTop: 0 }}>
          Every link from your report, with duplicates removed.
        </p>
        {referenceRows.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '1.5rem', color: theme.textDim }}>
            No sources yet. Run a Full Report on the Research page to fill this in.
          </div>
        ) : safeReferences.length === 0 ? (
          <div role="status" style={{ textAlign: 'center', padding: '1.5rem', color: theme.textDim }}>
            Report links were present, but none matched the server-provided source allowlist, so no links are shown.
          </div>
        ) : (
          <div style={{ marginTop: '0.75rem' }}>
            <Section title="PubMed / DOI" items={pubmedRefs} />
            <Section title="ClinicalTrials.gov" items={trialRefs} />
            <Section title="Other" items={otherRefs} />
          </div>
        )}
      </div>
    </div>
  );
};

/* ==================== Footer ==================== */
const TermsLink = () => {
  const { openTerms } = React.useContext(TermsContext);
  return (
    <button type="button" onClick={openTerms} style={{
      background: 'transparent', border: 'none', color: theme.accent,
      cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit', fontSize: 'inherit', padding: 0
    }}>
      Terms of Use
    </button>
  );
};

const Footer = ({ runtimeConfig, onEraseLocalData }) => (
  <footer style={{
    maxWidth: 1400, margin: '0 auto', padding: '1.5rem 2rem 2.5rem',
    color: theme.textDim, fontSize: '0.78rem'
  }}>
    <AdSlot runtimeConfig={runtimeConfig} slotKey="footer" minHeight={80} />
    <div style={{ borderTop: `1px solid ${theme.border}`, paddingTop: '1rem', lineHeight: 1.65 }}>
        <div style={{ marginBottom: '0.6rem' }}>
        <strong>For learning and research only.</strong> researchingmycondition.com is not medical advice,
        and using it does not make us your doctor. Talk to a licensed doctor before you make any
        treatment decision. This early version does not follow HIPAA privacy rules — do not type
        anything that could identify a person.{' '}
        <TermsLink />
        {' · '}
        <button type="button" onClick={onEraseLocalData}
          title="Reset demo/browser data"
          style={{
          background: 'transparent', border: 'none', color: theme.accent,
          cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit', fontSize: 'inherit', padding: 0
        }}>
          Erase local data
        </button>
      </div>
      <div style={{ color: theme.textDim, opacity: 0.85 }}>
        <strong>Where the facts come from:</strong> ClinicalTrials.gov · NCBI PubMed · Europe PMC ·
        OpenAlex · openFDA · Unpaywall · Cochrane Library · our trusted, hand-picked sources.
        <br />
        <strong>How it's made:</strong> An AI writes the report from the research sources above.
      </div>
    </div>
  </footer>
);

/* ==================== Sticky disclaimer banner ====================
   Dorothy explicitly asked: "can we have a banner at the bottom of
   everything that says this is not medical advice... nothing
   discovered on this site should be relied upon in the absence of
   a medical doctor." This bar sits fixed at the bottom of the
   viewport on every screen (incl. gate, profile, results). The
   body padding-bottom is bumped so content never hides behind it.
================================================================== */
const StickyDisclaimer = () => (
  <div
    role="contentinfo"
    aria-label="Medical disclaimer"
    style={{
      position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 9999,
      pointerEvents: 'none',
      background: 'rgba(120, 20, 20, 0.96)',
      color: '#fff5f5',
      borderTop: '2px solid rgba(255, 255, 255, 0.25)',
      boxShadow: '0 -4px 18px rgba(0,0,0,0.35)',
      padding: '0.55rem 0.9rem',
      fontSize: '0.78rem',
      lineHeight: 1.45,
      textAlign: 'center'
    }}
  >
    <strong style={{ color: '#fff' }}>NOT MEDICAL ADVICE.</strong>{' '}
    This tool is for learning only. Do not rely on anything here
    without a licensed doctor. Using it does not make us your doctor.
    Always check with your doctor before you make any treatment
    decision.
  </div>
);

/* ==================== Access gate UI ====================
   The first screen the user sees on a fresh device. If the deploy
   has MRT_ACCESS_PASSCODE set, the user MUST enter a matching
   passcode before the app loads. If the gate is OFF on the server
   (env var unset) we let the app render immediately — that path
   is for local dev and the test harness.
======================================================== */
const probeAccessGate = async () => {
  // Cheap GET-like probe via the runtime-config mode of /api/research.
  // Returns 200 when gate is off or passcode is valid, 401 when blocked.
  try {
    const r = await fetchGateRequest('/api/research', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'runtime-config' })
    });
    const body = r.ok ? null : await r.json().catch(() => null);
    return classifyAccessProbeResponse({
      status: r.status,
      code: body?.code,
      error: body?.error
    });
  } catch (e) {
    return { ok: false, gateEnabled: true, reason: 'Access could not be verified. Check your connection and try again.' };
  }
};

const AccessGate = () => {
  // 'probing' on first paint so we don't flash either screen.
  const [state, setState] = useState({ status: 'probing' });
  const [input, setInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const runProbe = async () => {
    const result = await probeAccessGate();
    if (result.ok) {
      setState({ status: 'allowed' });
    } else if (result.gateEnabled) {
      setState({ status: 'blocked', reason: result.reason });
    } else {
      setState({ status: 'blocked', reason: result.reason || 'Access could not be verified.' });
    }
  };

  useEffect(() => { runProbe(); }, []);

  useEffect(() => {
    const onDenied = () => {
      setState({ status: 'blocked', reason: 'Access passcode rejected. Please re-enter.' });
    };
    window.addEventListener('mrt:access-denied', onDenied);
    return () => window.removeEventListener('mrt:access-denied', onDenied);
  }, []);

  const submit = async (e) => {
    e?.preventDefault?.();
    const v = input.trim();
    if (!v) return;
    setSubmitting(true);
    setError('');
    try {
      const r = await fetchGateRequest('/api/access-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode: v })
      });
      if (r.ok) {
        setInput('');
        await runProbe();
      } else if (r.status === 401) {
        setError('That passcode was not accepted. Check it and try again.');
      } else if (r.status === 429) {
        // Repeated wrong attempts (from this device, this network, or the
        // site overall) trip a temporary lockout — the server rejects even
        // a CORRECT passcode with 429 until the window clears. Without this
        // branch that read like a generic hiccup ("try again in a moment"),
        // so a locked-out user kept retrying, which cannot ever succeed
        // during the lockout and only looked like the passcode was wrong.
        const retryAfterSec = Number(r.headers?.get?.('Retry-After'));
        const minutes = Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? Math.ceil(retryAfterSec / 60)
          : 15;
        setError(`Too many rejected attempts. This is temporarily locked — wait about ${minutes} minute${minutes === 1 ? '' : 's'} before trying again (retyping the passcode faster will not help).`);
      } else {
        setError('The service could not confirm access. Try again in a moment.');
      }
    } catch (err) {
      setError('The service could not be reached. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (state.status === 'probing') {
    return (
      <>
        <div style={{
          minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#9bb4c0', fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          fontSize: '0.95rem'
        }}>
          Checking access…
        </div>
        <StickyDisclaimer />
      </>
    );
  }
  if (state.status === 'blocked') {
    return (
      <>
        <div style={{
          minHeight: '100vh',
          background: 'radial-gradient(ellipse at top, #0d2030 0%, #061018 55%, #030910 100%)',
          color: '#eef5fa',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '2rem 1rem 5rem'
        }}>
          <form onSubmit={submit} style={{
            maxWidth: 460, width: '100%',
            background: 'rgba(16, 38, 56, 0.92)',
            border: '1px solid rgba(125, 211, 252, 0.22)',
            borderRadius: 12,
            padding: '2rem 1.75rem',
            boxShadow: '0 24px 60px rgba(0, 0, 0, 0.55)'
          }}>
            <h1 style={{
              margin: '0 0 0.4rem', fontSize: '1.45rem',
              fontFamily: '"Crimson Pro", Georgia, serif', color: '#22d3ee'
            }}>
              Private preview
            </h1>
            <p style={{ margin: '0 0 1.25rem', color: '#b8cdd9', lineHeight: 1.5, fontSize: '0.92rem' }}>
              researchingmycondition.com is restricted to invited testers.
              Enter the access passcode you were given to continue.
            </p>
            <label htmlFor="mrt-passcode" style={{
              display: 'block', fontSize: '0.78rem', color: '#b8cdd9',
              textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6
            }}>
              Access passcode
            </label>
            <input
              id="mrt-passcode"
              type="password"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Enter passcode"
              style={{
                width: '100%', boxSizing: 'border-box',
                padding: '0.7rem 0.85rem', fontSize: '0.95rem',
                background: 'rgba(3, 10, 18, 0.55)',
                border: '1px solid rgba(125, 211, 252, 0.32)',
                color: '#f5fafd', borderRadius: 8, outline: 'none'
              }}
            />
            {error && (
              <div role="alert" style={{
                marginTop: '0.7rem', color: '#fda4af', fontSize: '0.85rem'
              }}>
                {error}
              </div>
            )}
            {state.reason && !error && (
              <div role="status" aria-live="polite" style={{
                marginTop: '0.7rem', color: '#fcd34d', fontSize: '0.82rem', opacity: 0.85
              }}>
                {state.reason}
              </div>
            )}
            <button
              type="submit"
              disabled={submitting || !input.trim()}
              style={{
                marginTop: '1.25rem', width: '100%',
                padding: '0.75rem 1rem', fontSize: '0.95rem',
                background: submitting || !input.trim() ? 'rgba(34, 211, 238, 0.35)' : '#22d3ee',
                color: '#062032',
                border: 'none', borderRadius: 8, fontWeight: 600,
                cursor: submitting || !input.trim() ? 'not-allowed' : 'pointer'
              }}
            >
              {submitting ? 'Checking…' : 'Unlock'}
            </button>
            <p style={{
              marginTop: '1.25rem', fontSize: '0.75rem', color: '#7c97a3', lineHeight: 1.5
            }}>
              If you don't have a passcode, contact the support team
              (shaque025@gmail.com). The passcode is exchanged for a
              secure session cookie and is not stored in browser storage.
            </p>
          </form>
        </div>
        <StickyDisclaimer />
      </>
    );
  }
  // allowed → render the real app + persistent disclaimer.
  return (
    <>
      <TermsAcceptanceGate>
        <App />
      </TermsAcceptanceGate>
      <StickyDisclaimer />
    </>
  );
};

ReactDOM.render(<AccessGate />, document.getElementById('root'));

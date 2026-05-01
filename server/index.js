// server/index.js — OpenClaw Agent Local Server
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { google } from 'googleapis';
import open from 'open';
import 'dotenv/config';
 
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CONFIG_PATH = join(ROOT, 'config.json');
const TOKENS_PATH = join(ROOT, 'google-tokens.json');
 
// ─── Load config ────────────────────────────────────────────────
function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error('ERROR: config.json not found. Run the setup script first.');
    process.exit(1);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}
 
const config = loadConfig();
const PROFESSION = config.profession;
const API_KEY = config.anthropicApiKey;
const GOOGLE_CLIENT_ID = config.googleClientId;
const GOOGLE_CLIENT_SECRET = config.googleClientSecret;
 
// ─── Profession system prompts ──────────────────────────────────
const SYSTEM_PROMPTS = {
  banker: `You are an elite AI assistant for a senior commercial banker. You have live access to their Gmail and Google Drive.
 
Core capabilities:
- Financial analysis: credit risk, DCF models, LBO scenarios, capital ratios, balance sheet review
- Document drafting: credit memos, term sheets, loan covenant summaries, board presentations, client proposals
- Research & summarization: distill market data, Fed communications, earnings reports, regulatory filings
- Email management: read, summarize, and draft professional banking correspondence
- Drive access: retrieve and analyze financial documents, spreadsheets, and deal files
- Regulatory awareness: Basel III/IV, Dodd-Frank, OCC guidelines
 
When the user references emails or documents, use your tools to retrieve them immediately — don't ask, just fetch.
Structure analysis as: Borrower/Situation → Financials → Risk → Mitigants → Recommendation.
Lead with the bottom line. Be direct. Use precise financial terminology.
Flag if sensitive client data is being discussed.`,
 
  landlord: `You are an elite AI assistant for a commercial real estate landlord. You have live access to their Gmail and Google Drive.
 
Core capabilities:
- Lease analysis: review commercial leases, flag critical dates, co-tenancy clauses, kick-out provisions, CAM structures
- Financial modeling: NOI, cap rates, IRR/NPV, DSCR, cash-on-cash returns, hold vs. sell analysis
- Tenant management: draft communications, default notices, renewal proposals, lease amendments, estoppels
- Email management: read, summarize, and draft tenant, broker, and lender correspondence
- Drive access: retrieve leases, financial models, property documents, and due diligence files
- Market intelligence: rent comps, vacancy analysis, submarket dynamics
 
When the user references emails or documents, use your tools to retrieve them immediately — don't ask, just fetch.
Use precise CRE terminology: NNN, FSG, CAM, TI, LC, SNDA, estoppel, absorption, etc.
Be transactional and direct. Flag lease expiration and critical date risks proactively.`,
 
  lawyer: `You are an elite AI assistant for a practicing attorney. You have live access to their Gmail and Google Drive.
 
Core capabilities:
- Legal research: analyze legal issues, identify controlling authority, flag circuit splits and unsettled areas
- Document drafting: motions, briefs, memos, contracts, demand letters, settlement agreements, discovery
- Contract review: identify risk provisions, missing protections, liability exposure, negotiation leverage
- Email management: read, summarize, and draft professional legal correspondence
- Drive access: retrieve case files, contracts, research memos, and client documents
- Case support: fact chronologies, deposition outlines, discovery strategy
 
When the user references emails or documents, use your tools to retrieve them immediately — don't ask, just fetch.
Structure legal analysis as: Issue → Rule → Application → Conclusion (IRAC).
Treat the user as a sophisticated peer attorney. Flag jurisdictional variations. Never fabricate citations.
Privilege and confidentiality awareness: remind user if sharing sensitive client information.`
};
 
// ─── Google OAuth setup ─────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  'http://localhost:3747/oauth/callback'
);
 
function loadTokens() {
  if (existsSync(TOKENS_PATH)) {
    const tokens = JSON.parse(readFileSync(TOKENS_PATH, 'utf8'));
    oauth2Client.setCredentials(tokens);
    return true;
  }
  return false;
}
 
function saveTokens(tokens) {
  writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
}
 
oauth2Client.on('tokens', (tokens) => {
  const existing = existsSync(TOKENS_PATH)
    ? JSON.parse(readFileSync(TOKENS_PATH, 'utf8')) : {};
  saveTokens({ ...existing, ...tokens });
});
 
const tokensLoaded = loadTokens();
 
// ─── Google API helpers ─────────────────────────────────────────
const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
const drive = google.drive({ version: 'v3', auth: oauth2Client });
 
async function listEmails(query = '', maxResults = 10) {
  const res = await gmail.users.messages.list({
    userId: 'me', q: query, maxResults
  });
  if (!res.data.messages) return [];
 
  const emails = await Promise.all(
    res.data.messages.slice(0, maxResults).map(async (msg) => {
      const full = await gmail.users.messages.get({
        userId: 'me', id: msg.id, format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date']
      });
      const headers = full.data.payload.headers;
      const get = (name) => headers.find(h => h.name === name)?.value || '';
      return {
        id: msg.id,
        subject: get('Subject'),
        from: get('From'),
        date: get('Date'),
        snippet: full.data.snippet
      };
    })
  );
  return emails;
}
 
async function getEmailBody(messageId) {
  const msg = await gmail.users.messages.get({
    userId: 'me', id: messageId, format: 'full'
  });
  function extractText(payload) {
    if (payload.mimeType === 'text/plain' && payload.body.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf8');
    }
    if (payload.parts) {
      for (const part of payload.parts) {
        const text = extractText(part);
        if (text) return text;
      }
    }
    return '';
  }
  const headers = msg.data.payload.headers;
  const get = (name) => headers.find(h => h.name === name)?.value || '';
  return {
    subject: get('Subject'),
    from: get('From'),
    date: get('Date'),
    body: extractText(msg.data.payload)
  };
}
 
async function searchDrive(query, maxResults = 10) {
  const res = await drive.files.list({
    q: `name contains '${query.replace(/'/g, "\\'")}' and trashed = false`,
    pageSize: maxResults,
    fields: 'files(id, name, mimeType, modifiedTime, size)'
  });
  return res.data.files || [];
}
 
async function getDriveFileContent(fileId, mimeType) {
  if (mimeType === 'application/vnd.google-apps.document') {
    const res = await drive.files.export({
      fileId, mimeType: 'text/plain'
    }, { responseType: 'text' });
    return res.data;
  }
  if (mimeType === 'application/vnd.google-apps.spreadsheet') {
    const res = await drive.files.export({
      fileId, mimeType: 'text/csv'
    }, { responseType: 'text' });
    return res.data;
  }
  // For other files, return metadata only
  const res = await drive.files.get({ fileId, fields: '*' });
  return `File: ${res.data.name}\nType: ${res.data.mimeType}\nSize: ${res.data.size} bytes\nModified: ${res.data.modifiedTime}`;
}
 
async function draftEmail({ to, subject, body, replyToMessageId }) {
  const messageParts = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body
  ];
  const message = messageParts.join('\n');
  const encoded = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
 
  const params = { userId: 'me', requestBody: { message: { raw: encoded } } };
  if (replyToMessageId) params.requestBody.message.threadId = replyToMessageId;
 
  const res = await gmail.users.drafts.create(params);
  return res.data;
}
 
// ─── Anthropic tool definitions ─────────────────────────────────
const TOOLS = [
  {
    name: 'list_emails',
    description: 'List recent emails from Gmail, optionally filtered by a search query. Use Gmail search syntax (e.g., "from:john@example.com", "subject:lease renewal", "is:unread").',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query (optional)' },
        max_results: { type: 'number', description: 'Max emails to return (default 10, max 20)' }
      }
    }
  },
  {
    name: 'read_email',
    description: 'Read the full body of a specific email by its message ID.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Gmail message ID' }
      },
      required: ['message_id']
    }
  },
  {
    name: 'search_drive',
    description: 'Search for files in Google Drive by name or keyword.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term to find files' },
        max_results: { type: 'number', description: 'Max files to return (default 10)' }
      },
      required: ['query']
    }
  },
  {
    name: 'read_drive_file',
    description: 'Read the content of a Google Drive file (supports Google Docs and Sheets). For other file types, returns metadata.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'Google Drive file ID' },
        mime_type: { type: 'string', description: 'MIME type of the file' }
      },
      required: ['file_id', 'mime_type']
    }
  },
  {
    name: 'create_email_draft',
    description: 'Create a draft email in Gmail ready for the user to review and send.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body text' },
        reply_to_message_id: { type: 'string', description: 'Message ID to reply to (optional)' }
      },
      required: ['to', 'subject', 'body']
    }
  }
];
 
// ─── Tool execution ──────────────────────────────────────────────
async function executeTool(name, input) {
  try {
    switch (name) {
      case 'list_emails':
        return await listEmails(input.query || '', Math.min(input.max_results || 10, 20));
      case 'read_email':
        return await getEmailBody(input.message_id);
      case 'search_drive':
        return await searchDrive(input.query, input.max_results || 10);
      case 'read_drive_file':
        return await getDriveFileContent(input.file_id, input.mime_type);
      case 'create_email_draft':
        return await draftEmail({
          to: input.to,
          subject: input.subject,
          body: input.body,
          replyToMessageId: input.reply_to_message_id
        });
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}
 
// ─── Anthropic agentic loop ─────────────────────────────────────
async function runAgent(messages, onChunk) {
  const anthropic = new Anthropic({ apiKey: API_KEY });
 
  let currentMessages = [...messages];
 
  while (true) {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: SYSTEM_PROMPTS[PROFESSION],
      tools: TOOLS,
      messages: currentMessages
    });
 
    // Collect text and tool use blocks
    let textContent = '';
    const toolUseBlocks = [];
 
    for (const block of response.content) {
      if (block.type === 'text') {
        textContent += block.text;
        onChunk({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        toolUseBlocks.push(block);
        onChunk({ type: 'tool_start', toolName: block.name, toolInput: block.input });
      }
    }
 
    // If no tool use, we're done
    if (response.stop_reason === 'end_turn' || toolUseBlocks.length === 0) {
      onChunk({ type: 'done' });
      return;
    }
 
    // Execute tools and build tool results
    const toolResults = [];
    for (const toolBlock of toolUseBlocks) {
      onChunk({ type: 'tool_running', toolName: toolBlock.name });
      const result = await executeTool(toolBlock.name, toolBlock.input);
      onChunk({ type: 'tool_done', toolName: toolBlock.name, result });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolBlock.id,
        content: JSON.stringify(result)
      });
    }
 
    // Continue the loop
    currentMessages = [
      ...currentMessages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: toolResults }
    ];
  }
}
 
// ─── Express server ──────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(join(ROOT, 'public')));
 
// Config endpoint (profession, auth status)
app.get('/api/config', (req, res) => {
  res.json({
    profession: PROFESSION,
    googleConnected: existsSync(TOKENS_PATH)
  });
});
 
// OAuth flow
app.get('/oauth/start', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/drive.readonly'
    ],
    prompt: 'consent'
  });
  res.redirect(url);
});
 
app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  saveTokens(tokens);
  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0e0e0f;color:#e8e8ec">
      <h2 style="color:#c8a96e">✓ Google account connected</h2>
      <p>You can close this tab and return to OpenClaw.</p>
      <script>setTimeout(()=>window.close(),2000)</script>
    </body></html>
  `);
});
 
// WebSocket for streaming agent responses
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
 
wss.on('connection', (ws) => {
  ws.on('message', async (data) => {
    let parsed;
    try { parsed = JSON.parse(data); } catch { return; }
 
    if (parsed.type === 'chat') {
      try {
        await runAgent(parsed.messages, (chunk) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(chunk));
          }
        });
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
    }
  });
});
 
const PORT = 3747;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  OpenClaw Agent running`);
  console.log(`  Profession: ${PROFESSION}`);
  console.log(`  Google: ${existsSync(TOKENS_PATH) ? '✓ connected' : '✗ not connected (run /oauth/start)'}`);
  console.log(`  URL: http://localhost:${PORT}\n`);
  // Auto-open browser
  open(`http://localhost:${PORT}`);
});
 

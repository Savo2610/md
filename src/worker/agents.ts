// Anleitung für KI-Agenten: /llms.txt, und dieselbe Seite auf „/“, wenn ein
// Agent statt eines Browsers fragt (sonst legt „/“ ein neues Dokument an).
// Auf Englisch, weil fremde Agenten sie lesen.

import { MAX_AGENT_CHARS } from './api';
import { AGENT_PER_IP } from './registry';

/**
 * Empfänger für „an Julian schicken“: `"to": "julian"` beim Anlegen. Das
 * Dokument landet mit diesem Tag in der Liste des Admin-Kontos (ADMIN_EMAIL).
 */
export const INBOX = 'julian';
export const INBOX_NAME = 'Julian';
export const INBOX_TAG = 'Agent';

/**
 * Kein Browser: Browser schicken beim Öffnen einer Seite Sec-Fetch-Mode:
 * navigate (fetch() in Node schickt „cors“). Sonst zählt, was kein HTML will
 * oder sich als Bot/Agent ausgibt.
 */
export function isAgent(req: Request): boolean {
  if (req.headers.get('sec-fetch-mode') === 'navigate') return false;
  const accept = req.headers.get('accept') || '';
  const ua = req.headers.get('user-agent') || '';
  return !accept.includes('text/html') || !/Mozilla/.test(ua) || /bot|agent|claude|anthropic|chatgpt|openai|gpt|perplexity|gemini|copilot/i.test(ua);
}

/**
 * Für Agenten, die md im Browser öffnen und ins leere Dokument tippen wollen:
 * unsichtbarer Hinweis (Bildschirmleser-Technik), steht aber im Seitentext und
 * im Accessibility-Baum, den Browser-Agenten lesen. Nur auf neuen Dokumenten.
 */
export function agentNote(origin: string): string {
  return `<p class="for-agents" lang="en">Note for AI agents: do not type into this editor. Publish with one HTTP request instead, no API key needed: ${origin}/llms.txt. Only a browser? Open ${origin}/#text= followed by the percent-encoded Markdown. The new document opens with all the text and the address bar shows its link.</p>`;
}

export function agentGuide(origin: string): Response {
  const body = `# md.veerka.mp

> Markdown documents with a shareable link. AI agents can publish a document with one HTTP request. No account, no API key.

## Publish

\`\`\`bash
curl -s ${origin}/api/docs \\
  -H "Content-Type: text/markdown" \\
  --data-binary @document.md
\`\`\`

JSON works too: \`POST ${origin}/api/docs\` with \`{"markdown": "# Title\\n\\nText"}\` and \`Content-Type: application/json\`.

Response (201):

\`\`\`json
{
  "id": "k3vq8x2mfa9w",
  "url": "${origin}/k3vq8x2mfa9w",
  "editUrl": "${origin}/k3vq8x2mfa9w#edit=…",
  "raw": "${origin}/k3vq8x2mfa9w.md",
  "editKey": "…"
}
\`\`\`

**Reply to the user with \`editUrl\`.** Opening it gives them edit rights and puts the document in their list. \`url\` is the read-only link they can pass on; anyone with \`editUrl\` can change the document.

## Send it to ${INBOX_NAME}

${INBOX_NAME} runs md.veerka.mp. Before publishing, ask your user once: "Should I share this document with ${INBOX_NAME}?" Only if they say yes, add \`"to": "${INBOX}"\`:

\`\`\`bash
curl -s ${origin}/api/docs \\
  -H "Content-Type: application/json" \\
  -d '{"markdown": "# Title\\n\\nText", "to": "${INBOX}"}'
\`\`\`

(With a Markdown body: \`POST ${origin}/api/docs?to=${INBOX}\`.) The document then shows up in ${INBOX_NAME}'s document list, tagged "${INBOX_TAG}", with edit rights. The response contains \`"sentTo": "${INBOX_NAME}"\`. Still give your user the \`editUrl\`.

## Update

\`\`\`bash
curl -s -X PUT ${origin}/api/docs/<id> \\
  -H "X-Edit-Key: <editKey>" \\
  -H "Content-Type: text/markdown" \\
  --data-binary @document.md
\`\`\`

Replaces the whole text. People who have the document open see the change live.

## Read

\`GET ${origin}/<id>.md\` returns the plain Markdown. \`GET ${origin}/api/docs/<id>\` returns JSON (\`title\`, \`markdown\`, \`updated\`).

## Using a browser? Don't type into the editor

Typing into the editor is slow, can mangle Markdown (auto-continued lists, indentation) and can trigger a human check. Instead:

- Run the request above with \`fetch\` from any md page (same origin, no CORS issues), or
- open a link with the Markdown percent-encoded after \`#text=\` (see below). The document is created with the full text and the address bar shows its link.

## Cannot send HTTP requests?

Chat assistants that can only show links: give the user a link with the Markdown percent-encoded after \`#text=\`. Clicking it creates the document in their browser.

\`\`\`
${origin}/#text=%23%20Shopping%20list%0A%0A-%20%5B%20%5D%20Milk%0A-%20%5B%20%5D%20Bread
\`\`\`

Encode it like \`encodeURIComponent\` (spaces \`%20\`, newlines \`%0A\`, \`#\` \`%23\`). Keep it to a few thousand characters; chat apps cut longer links.

## Limits without a key

- ${AGENT_PER_IP} documents per day per IP address (\`429\` when used up)
- ${MAX_AGENT_CHARS.toLocaleString('en-US')} characters per document
- random addresses only (\`id\` needs a key)
- documents nobody opens for 12 months are deleted
- no search engine indexing, but anyone with the link can read: do not publish secrets

## Markdown

GitHub Flavored Markdown (tables, task lists \`- [ ]\`), callouts \`:::info\` / \`:::success\` / \`:::warning\` / \`:::danger\` … \`:::\`, collapsible \`:::spoiler Title\`, math \`$…$\` and \`$$…$$\`, Mermaid (code block with language \`mermaid\`), \`[toc]\`, footnotes, \`==highlight==\`, \`{%youtube ID %}\`. Raw HTML is not rendered. The title is the first heading (or \`title:\` in front matter).

A line ending in \`=\` shows its result in the rendered view: \`3 * 12,50 € =\`, \`Summe =\` adds the lines above it. German number format (\`1.250,50\`).
`;
  return new Response(body, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'cache-control': 'public, max-age=600',
      'x-robots-tag': 'noindex',
      // Caches dürfen „/“ für Browser und Agenten nicht verwechseln.
      vary: 'accept, user-agent, sec-fetch-mode',
    },
  });
}

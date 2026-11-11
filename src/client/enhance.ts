// Macht aus den Platzhaltern des Renderers echte Darstellung. Die schweren
// Bibliotheken werden nur geladen, wenn das Dokument sie wirklich braucht.

let katexCssLoaded = false;
let mermaidReady: Promise<typeof import('mermaid').default> | null = null;

const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;

export async function enhance(root: HTMLElement, katexCss?: string) {
  const jobs: Promise<unknown>[] = [];

  const code = root.querySelectorAll<HTMLElement>('pre > code[class*="language-"]');
  if (code.length) {
    jobs.push(import('highlight.js/lib/common').then(({ default: hljs }) => {
      for (const el of code) {
        const lang = /language-([\w+#-]+)/.exec(el.className)?.[1];
        if (!lang || !hljs.getLanguage(lang)) continue;
        el.innerHTML = hljs.highlight(el.textContent || '', { language: lang, ignoreIllegals: true }).value;
        el.classList.add('hljs');
      }
    }));
  }

  const math = root.querySelectorAll<HTMLElement>('.math');
  if (math.length) {
    if (!katexCssLoaded && katexCss) {
      katexCssLoaded = true;
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = katexCss;
      document.head.append(link);
    }
    jobs.push(import('katex').then(({ default: katex }) => {
      for (const el of math) {
        katex.render(el.textContent || '', el, { displayMode: el.classList.contains('math-display'), throwOnError: false });
        el.classList.add('katex-rendered');
      }
    }));
  }

  const diagrams = root.querySelectorAll<HTMLElement>('pre.mermaid');
  if (diagrams.length) {
    mermaidReady ??= import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: dark() ? 'dark' : 'neutral',
        fontFamily: 'iA Writer Quattro, system-ui, sans-serif',
        // Kurze deutsche Datumsangaben, sonst überlappen sich die Achsenbeschriftungen.
        gantt: { axisFormat: '%d.%m.' },
      });
      return mermaid;
    });
    jobs.push(mermaidReady.then(m => m.run({ nodes: [...diagrams], suppressErrors: true })));
  }

  await Promise.allSettled(jobs);
}

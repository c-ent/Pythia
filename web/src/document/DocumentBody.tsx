import { ExternalLink, Image } from 'lucide-react'
import type { MouseEvent } from 'react'
import Markdown, { type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import type { DocumentView } from '../api/documents'
import { codeFence, isMarkdown } from './format'
import { remarkObsidian } from './obsidian'

const isWebUrl = (url: string | undefined): url is string => url !== undefined && /^(?:https?:|mailto:)/i.test(url)
// Not a type guard: a non-web href is still a string, so the guard above would narrow it to undefined.
const isHeadingLink = (url: string | undefined): boolean => url !== undefined && /^#h-\S+$/.test(url)

/** Scrolls to a heading in this note without touching the URL (the router owns it). */
function jumpToHeading(event: MouseEvent<HTMLAnchorElement>, id: string) {
  const target = document.getElementById(id)
  if (target === null) return
  event.preventDefault()
  target.scrollIntoView({ block: 'start' })
  // Moves keyboard focus too, so Tab continues from the heading.
  target.setAttribute('tabindex', '-1')
  target.focus({ preventScroll: true })
}

/**
 * Markdown is rendered without raw HTML (react-markdown drops it). The page
 * keeps one `h1` (the document title), so note headings move down a level.
 * Obsidian callouts and wikilinks go through `remarkObsidian`. Web and mail
 * links stay links, and so do links to a heading in the same note; links to
 * other notes have no page here and show as text. Images never load: a
 * note's remote image would be a request to a third party, so it shows as a
 * link to the image instead.
 */
const components: Components = {
  h1: ({ children, id }) => <h2 id={id}>{children}</h2>,
  h2: ({ children, id }) => <h3 id={id}>{children}</h3>,
  h3: ({ children, id }) => <h4 id={id}>{children}</h4>,
  h4: ({ children, id }) => <h5 id={id}>{children}</h5>,
  h5: ({ children, id }) => <h6 id={id}>{children}</h6>,
  h6: ({ children, id }) => <h6 id={id}>{children}</h6>,
  a: ({ href, children }) =>
    isWebUrl(href) ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : isHeadingLink(href) ? (
      <a href={href} onClick={(event) => jumpToHeading(event, (href ?? '').slice(1))}>
        {children}
      </a>
    ) : (
      <span className="text-accent-ink" title={href}>
        {children}
      </span>
    ),
  img: ({ src, alt }) => {
    const label = alt === undefined || alt === '' ? 'Image' : `Image: ${alt}`
    if (typeof src !== 'string' || !isWebUrl(src)) return <span className="text-muted">[{label}]</span>
    return (
      <a href={src} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1">
        <Image aria-hidden="true" className="size-4" />
        {label}
        <ExternalLink aria-hidden="true" className="size-3.5" />
      </a>
    )
  },
}

const remarkPlugins = [remarkGfm, remarkObsidian]
const rehypePlugins = [rehypeHighlight]

/** The document text: rendered Markdown for notes, one highlighted code block for code files (R6). */
export function DocumentBody({ doc }: { doc: Pick<DocumentView, 'content' | 'language' | 'source'> }) {
  const markdown = isMarkdown(doc) ? doc.content : codeFence(doc.content, doc.language)
  return (
    <div className="markdown">
      <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {markdown}
      </Markdown>
    </div>
  )
}

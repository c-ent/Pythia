import { ExternalLink, Image } from 'lucide-react'
import Markdown, { type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import type { DocumentView } from '../api/documents'
import { codeFence, isMarkdown } from './format'

const isWebUrl = (url: string | undefined): url is string => url !== undefined && /^(?:https?:|mailto:)/i.test(url)

/**
 * Markdown is rendered without raw HTML (react-markdown drops it). The page
 * keeps one `h1` (the document title), so note headings move down a level.
 * Only web and mail links stay links; Obsidian-relative links have no page
 * here and show as text. Images never load: a note's remote image would be a
 * request to a third party, so it shows as a link to the image instead.
 */
const components: Components = {
  h1: ({ children }) => <h2>{children}</h2>,
  h2: ({ children }) => <h3>{children}</h3>,
  h3: ({ children }) => <h4>{children}</h4>,
  h4: ({ children }) => <h5>{children}</h5>,
  h5: ({ children }) => <h6>{children}</h6>,
  h6: ({ children }) => <h6>{children}</h6>,
  a: ({ href, children }) =>
    isWebUrl(href) ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span className="text-accent" title={href}>
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

const remarkPlugins = [remarkGfm]
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

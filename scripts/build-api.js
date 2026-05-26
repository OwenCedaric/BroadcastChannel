import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import rss from '@astrojs/rss'
import sanitizeHtml from 'sanitize-html'

import { fetchChannelMeta } from './telegram-parser.js'

try {
  const dotenv = await import('dotenv')
  dotenv.default.config()
}
catch (e) {}

const DATA_DIR = path.resolve(process.cwd(), 'data')
const RAW_DIR = path.resolve(DATA_DIR, 'raw')
const API_DIR = path.resolve(DATA_DIR, 'api')

const PAGE_SIZE = 20

// Base URL for static assets (images/videos/audio) - must be absolute for cross-domain

// Ensure API directory exists
async function ensureDirs() {
  await fs.mkdir(API_DIR, { recursive: true })
}

// Download a single URL and return local path
async function downloadAndLocalize(url) {
  const STATIC_DIR = path.join(API_DIR, 'static')
  await fs.mkdir(STATIC_DIR, { recursive: true })

  if (url.startsWith('/static/')) {
    url = url.slice(8)
  }
  if (!url.startsWith('http'))
    return null

  try {
    const urlObj = new URL(url)
    const extMatch = urlObj.pathname.match(/\.(jpg|jpeg|png|gif|webp|mp4|webm|ogg|wav|mp3)$/i)
    const ext = extMatch ? extMatch[1] : 'jpg'

    const hash = crypto.createHash('md5').update(url).digest('hex')
    const filename = `${hash}.${ext}`
    const localPath = path.join(STATIC_DIR, filename)

    const exists = await fs.access(localPath).then(() => true).catch(() => false)
    if (!exists) {
      console.info(`[Stage 2] Downloading media: ${url}`)
      const res = await fetch(url)
      if (res.ok) {
        const buffer = await res.arrayBuffer()
        await fs.writeFile(localPath, Buffer.from(buffer))
      }
      else {
        console.info(`[Stage 2] Failed to download media (status ${res.status}): ${url}`)
        return null
      }
    }
    return `/static/${filename}`
  }
  catch (e) {
    console.error(`[Stage 2] Error processing URL: ${url}`, e.message)
    return null
  }
}

// Localize a standalone URL (e.g. avatar)
async function localizeUrl(url) {
  if (!url || !url.includes('://'))
    return url
  const localPath = await downloadAndLocalize(url)
  return localPath || url
}

async function localizeImages(html) {
  if (!html)
    return html

  // Match src="..." or poster="..." containing http/https URLs or /static/http URLs
  const attrRegex = /(src|poster)=["']((?:\/static\/)?https?:\/\/[^"']+)["']/g
  // Match background-image:url('...') containing CDN URLs
  const bgRegex = /(background-image:\s*url\(['"]?)((?:\/static\/)?https?:\/\/[^)'"]+)(['"]?\))/g
  let newHtml = html

  // Process src/poster attributes
  for (const match of html.matchAll(attrRegex)) {
    const fullMatch = match[0]
    const attr = match[1]
    const rawUrl = match[2]
    const localPath = await downloadAndLocalize(rawUrl)
    // Use local path if downloaded, otherwise strip /static/ prefix
    const finalUrl = localPath || (rawUrl.startsWith('/static/') ? rawUrl.slice(8) : rawUrl)
    newHtml = newHtml.replaceAll(fullMatch, `${attr}="${finalUrl}"`)
  }

  // Process background-image:url(...) patterns
  for (const match of html.matchAll(bgRegex)) {
    const fullMatch = match[0]
    const prefix = match[1]
    const suffix = match[3]
    const rawUrl = match[2]
    const localPath = await downloadAndLocalize(rawUrl)
    const finalUrl = localPath || (rawUrl.startsWith('/static/') ? rawUrl.slice(8) : rawUrl)
    newHtml = newHtml.replaceAll(fullMatch, `${prefix}${finalUrl}${suffix}`)
  }

  return newHtml
}

// Read all raw chunks, merge, and sort
async function loadAllPosts() {
  const files = await fs.readdir(RAW_DIR)
  const jsonFiles = files.filter(f => f.startsWith('raw-') && f.endsWith('.json'))

  const allPostsMap = new Map()

  for (const file of jsonFiles) {
    const rawPath = path.join(RAW_DIR, file)
    const content = await fs.readFile(rawPath, 'utf-8')
    const posts = JSON.parse(content)

    let modified = false

    for (const post of posts) {
      if (post.content) {
        const newContent = await localizeImages(post.content)
        if (newContent !== post.content) {
          post.content = newContent
          modified = true
        }
      }
      allPostsMap.set(post.id, post)
    }

    if (modified) {
      await fs.writeFile(rawPath, JSON.stringify(posts, null, 2))
      console.info(`[Stage 2] Localized images in ${file}`)
    }
  }

  const merged = Array.from(allPostsMap.values())
  // Sort descending: newest first
  merged.sort((a, b) => Number.parseInt(b.id, 10) - Number.parseInt(a.id, 10))
  return merged
}

async function buildPages(posts, channelMeta) {
  const totalPosts = posts.length
  const totalPages = Math.ceil(totalPosts / PAGE_SIZE)

  console.info(`[Stage 2] Building ${totalPages} pages for ${totalPosts} posts...`)

  for (let i = 0; i < totalPages; i++) {
    const offset = i * PAGE_SIZE
    const pagePosts = posts.slice(offset, offset + PAGE_SIZE)

    // Naming logic: latest.json, latest-20.json, latest-40.json, etc
    const filename = i === 0 ? 'latest.json' : `latest-${offset}.json`
    const filepath = path.join(API_DIR, filename)

    // Inject pagination metadata directly into the response payload for Astro
    const payload = {
      meta: {
        ...channelMeta,
        totalPosts,
        totalPages,
        currentPage: i + 1,
        pageSize: PAGE_SIZE,
        hasNextPage: i < totalPages - 1,
        hasPrevPage: i > 0,
        nextPageUrl: i < totalPages - 1 ? `latest-${offset + PAGE_SIZE}.json` : null,
        prevPageUrl: i > 0 ? (i === 1 ? 'latest.json' : `latest-${offset - PAGE_SIZE}.json`) : null,
      },
      data: pagePosts,
    }

    await fs.writeFile(filepath, JSON.stringify(payload, null, 2))
  }

  // Generate individual post files for the `/posts/[id]` permalinks
  const POSTS_DIR = path.join(API_DIR, 'posts')
  await fs.mkdir(POSTS_DIR, { recursive: true })
  for (let idx = 0; idx < posts.length; idx++) {
    const post = posts[idx]
    const nextPostId = idx > 0 ? posts[idx - 1].id : null
    const prevPostId = idx < posts.length - 1 ? posts[idx + 1].id : null

    await fs.writeFile(
      path.join(POSTS_DIR, `${post.id}.json`),
      JSON.stringify({
        ...post,
        nextPostId,
        prevPostId,
      }),
    )
  }

  // Also write a standalone meta.json
  // Only update lastUpdated when actual content changes to avoid unnecessary git diffs
  const metaPath = path.join(API_DIR, 'meta.json')
  const newMetaCore = {
    ...channelMeta,
    totalPosts,
    totalPages,
    pageSize: PAGE_SIZE,
    latestPostId: posts.length > 0 ? posts[0].id : null,
  }

  let lastUpdated = new Date().toISOString()
  try {
    const existingMeta = JSON.parse(await fs.readFile(metaPath, 'utf-8'))
    const { lastUpdated: _oldTs, ...existingCore } = existingMeta
    if (JSON.stringify(existingCore) === JSON.stringify(newMetaCore)) {
      lastUpdated = _oldTs // content unchanged, preserve old timestamp
    }
  }
  catch {}

  await fs.writeFile(metaPath, JSON.stringify({
    ...newMetaCore,
    lastUpdated,
  }, null, 2))

  // Generate a lightweight search index for the frontend/server search pages
  const searchIndex = posts.map(p => ({
    id: p.id,
    title: p.title,
    text: p.text,
    datetime: p.datetime,
    tags: p.tags,
  }))
  await fs.writeFile(path.join(API_DIR, 'search.json'), JSON.stringify(searchIndex))
  console.info(`[Stage 2] Generated meta.json and search.json (Index size: ${searchIndex.length} posts)`)
}

async function buildSitemap(siteUrl) {
  const files = await fs.readdir(RAW_DIR)
  const jsonFiles = files.filter(f => f.startsWith('raw-') && f.endsWith('.json'))

  const SITEMAP_DIR = path.join(API_DIR, 'sitemap')
  await fs.mkdir(SITEMAP_DIR, { recursive: true })

  const sitemaps = []

  for (const file of jsonFiles) {
    const content = await fs.readFile(path.join(RAW_DIR, file), 'utf-8')
    const posts = JSON.parse(content)

    const pageMatch = file.match(/raw-(\d+)\.json/)
    if (!pageMatch)
      continue
    const page = pageMatch[1]

    if (posts.length === 0)
      continue

    const urls = posts.map(p => `
  <url>
    <loc>${siteUrl}/posts/${p.id}</loc>
    <lastmod>${new Date(p.datetime).toISOString()}</lastmod>
  </url>`).join('')

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`

    await fs.writeFile(path.join(SITEMAP_DIR, `${page}.xml`), xml)
    sitemaps.push(page)
  }

  if (sitemaps.length === 0)
    return

  // sort sitemaps descending
  sitemaps.sort((a, b) => Number.parseInt(b, 10) - Number.parseInt(a, 10))

  const indexXmlUrls = sitemaps.map(page => `
  <sitemap>
    <loc>${siteUrl}/sitemap/${page}.xml</loc>
  </sitemap>`).join('')

  const indexXml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${indexXmlUrls}
</sitemapindex>`

  await fs.writeFile(path.join(API_DIR, 'sitemap-index.xml'), indexXml)
  console.info(`[Stage 2] Generated sitemap-index.xml and ${sitemaps.length} individual sitemaps`)
}

async function buildHtmlIndex(channelName) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${channelName} Static API</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #333; }
    a { color: #0366d6; text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { background: #f6f8fa; padding: 2px 6px; border-radius: 4px; }
    h1 { border-bottom: 2px solid #eaecef; padding-bottom: 10px; }
  </style>
</head>
<body>
  <h1>📡 ${channelName} Static API Node</h1>
  <p>This is the auto-generated static data layer for the BroadcastChannel project.</p>
  <ul>
    <li><a href="api/meta.json"><code>/api/meta.json</code></a> - Global Channel Configuration & Stats</li>
    <li><a href="api/search.json"><code>/api/search.json</code></a> - Search Index Database</li>
    <li><a href="api/latest.json"><code>/api/latest.json</code></a> - Latest page data (Page 1)</li>
    <li><a href="api/rss.xml"><code>/api/rss.xml</code></a> - Standard RSS Feed</li>
    <li><a href="api/rss.json"><code>/api/rss.json</code></a> - JSON Feed</li>
    <li><a href="api/sitemap-index.xml"><code>/api/sitemap-index.xml</code></a> - SEO Sitemap Index</li>
    <li><a href="raw/raw-500.json"><code>/raw/raw-500.json</code></a> - Example Raw Chunk File</li>
  </ul>
</body>
</html>`
  // We write the index.html OUTSIDE of /api, directly into /data so it becomes the root index
  await fs.writeFile(path.join(DATA_DIR, 'index.html'), html)
  console.info('[Stage 2] Generated root index.html')
}

async function buildRss(posts, siteUrl, channelName) {
  if (!posts.length)
    return

  // Need a trailing slash to avoid Astro rss plugin validation issues
  const baseUrl = siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`

  const response = await rss({
    title: channelName,
    description: `Telegram Broadcast Channel for ${channelName}`,
    site: baseUrl,
    trailingSlash: false,
    items: posts.slice(0, 50).map(item => ({ // Only put newest 50 in RSS feed
      link: `posts/${item.id}`,
      title: item.title || `Post #${item.id}`,
      description: item.description || '',
      pubDate: new Date(item.datetime),
      content: sanitizeHtml(item.content || '', {
        allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'video', 'audio']),
        allowedAttributes: {
          ...sanitizeHtml.defaults.allowedAttributes,
          video: ['src', 'width', 'height', 'poster'],
          audio: ['src', 'controls'],
          img: ['src', 'srcset', 'alt', 'title', 'width', 'height', 'loading', 'class'],
        },
        exclusiveFilter(frame) {
          return frame.tag === 'img' && frame.attribs?.class?.includes('modal-img')
        },
      }),
    })),
  })

  // Convert standard web Response to string
  const xml = await response.text()
  await fs.writeFile(path.join(API_DIR, 'rss.xml'), xml)
  console.info('[Stage 2] Generated rss.xml')

  // Generate rss.json payload as well
  const jsonFeed = {
    version: 'https://jsonfeed.org/version/1.1',
    title: channelName,
    description: `Telegram Broadcast Channel for ${channelName}`,
    home_page_url: baseUrl,
    items: posts.slice(0, 50).map(item => ({
      url: `${baseUrl}posts/${item.id}`,
      title: item.title || `Post #${item.id}`,
      description: item.description || '',
      date_published: new Date(item.datetime),
      tags: item.tags,
      content_html: item.content,
    })),
  }

  await fs.writeFile(path.join(API_DIR, 'rss.json'), JSON.stringify(jsonFeed, null, 2))
  console.info('[Stage 2] Generated rss.json')
}

async function main() {
  await ensureDirs()

  const channelName = process.env.CHANNEL || 'BroadcastChannel'
  // When running locally, SITE_URL might not be set. Fallback for generation logic.
  const siteUrl = process.env.SITE_URL || 'https://example.com'

  console.info(`[Stage 2] Building API for ${channelName}`)

  const posts = await loadAllPosts()

  if (posts.length === 0) {
    console.info('[Stage 2] No posts found. Aborting.')
    return
  }

  // Short-circuit: check if the latest post ID we just loaded matches the latest post ID from the previous run
  let existingMeta = null
  try {
    const metaPath = path.join(API_DIR, 'meta.json')
    existingMeta = JSON.parse(await fs.readFile(metaPath, 'utf-8'))
    const latestPostId = posts[0].id

    // We can assume if totalPosts are the same and the most recent ID is the same, no new data has been added
    // (Assuming no deletions middle of the chain that wouldn't affect the newest ID)
    if (existingMeta.latestPostId === latestPostId && existingMeta.totalPosts === posts.length) {
      console.info('[Stage 2] No new posts detected since last build. Skipping API and static assets generation.')
      return
    }
  }
  catch (e) {
    // meta.json likely doesn't exist yet, proceed with full build
  }

  const channelMeta = await fetchChannelMeta({ channel: process.env.CHANNEL || 'miantiao_me' })

  // Localize channel avatar
  if (existingMeta?.avatar?.startsWith('/static/')) {
    channelMeta.avatar = existingMeta.avatar
    console.info(`[Stage 2] Reused existing local channel avatar: ${channelMeta.avatar}`)
  } else if (channelMeta.avatar) {
    channelMeta.avatar = await localizeUrl(channelMeta.avatar)
    console.info(`[Stage 2] Localized channel avatar: ${channelMeta.avatar}`)
  }

  await buildPages(posts, channelMeta)
  await buildSitemap(siteUrl)
  await buildRss(posts, siteUrl, channelName)
  await buildHtmlIndex(channelName)

  console.info(`[Stage 2] Build complete. Output generated at ${API_DIR}`)
}

main().catch((err) => {
  console.error('[Stage 2] Error:', err)
  process.exit(1)
})

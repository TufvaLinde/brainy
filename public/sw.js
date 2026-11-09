/* Brainy's service worker: keeps the app itself, its code and pictures, so
   it opens and runs with no connection. Its data lives in IndexedDB, and the
   on-device model's weights in the model's own cache; neither passes here. */
const CACHE = "brainy-v2"
const SHELL = ["/", "/manifest.webmanifest", "/icons/192", "/icons/512"]

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => Promise.all(SHELL.map(url => cache.add(url).catch(() => {})))).then(() => self.skipWaiting()))
})

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()))
})

/* The first visit loads before this worker controls the page: it sends what it loaded, to keep. */
self.addEventListener("message", event => {
  if (event.data?.type !== "keep") return
  event.waitUntil(caches.open(CACHE).then(cache => Promise.all(event.data.urls.map(url =>
    cache.match(url).then(hit => hit || cache.add(url).catch(() => {}))))))
})

const fresh = async (request, timeout) => {
  const cache = await caches.open(CACHE)
  try {
    const response = await Promise.race([fetch(request), new Promise((_, reject) => setTimeout(() => reject(new Error("slow")), timeout))])
    if (response.ok) cache.put(request, response.clone())
    return response
  } catch (error) {
    const hit = await cache.match(request, { ignoreSearch: request.mode === "navigate" })
    if (hit) return hit
    if (request.mode === "navigate") return (await cache.match("/")) || Response.error()
    throw error
  }
}

const kept = async request => {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(request)
  if (hit) return hit
  const response = await fetch(request)
  if (response.ok) cache.put(request, response.clone())
  return response
}

self.addEventListener("fetch", event => {
  const { request } = event
  const url = new URL(request.url)
  if (request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return
  // Code and pictures never change at their address.
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/_next/image") || url.pathname.startsWith("/images/")) {
    event.respondWith(kept(request))
  } else if (request.mode === "navigate") {
    event.respondWith(fresh(request, 3500))
  } else {
    event.respondWith(fresh(request, 6000))
  }
})

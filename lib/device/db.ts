/** What the device keeps on itself, in IndexedDB, so it works with no
 *  connection: the catalogue, items' readings, the events not yet handed to
 *  the cloud, and the profiles. */

const NAME = "brainy"
const STORES = ["catalog", "readings", "outbox", "kv"] as const
type Store = (typeof STORES)[number]

let opened: Promise<IDBDatabase> | undefined
function open(): Promise<IDBDatabase> {
  return opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME, 1)
    request.onupgradeneeded = () => {
      for (const store of STORES) if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => { opened = undefined; reject(request.error) }
  })
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function store(name: Store, mode: IDBTransactionMode) {
  return (await open()).transaction(name, mode).objectStore(name)
}

export async function get<T>(name: Store, key: IDBValidKey): Promise<T | undefined> {
  return done((await store(name, "readonly")).get(key))
}
export async function put(name: Store, key: IDBValidKey, value: unknown): Promise<void> {
  await done((await store(name, "readwrite")).put(value, key))
}
export async function remove(name: Store, keys: IDBValidKey[]): Promise<void> {
  const s = await store(name, "readwrite")
  await Promise.all(keys.map(key => done(s.delete(key))))
}
export async function all<T>(name: Store): Promise<T[]> {
  return done((await store(name, "readonly")).getAll())
}
export async function keys(name: Store): Promise<IDBValidKey[]> {
  return done((await store(name, "readonly")).getAllKeys())
}
/** Replace a whole store at once: the catalogue, as the cloud last sent it. */
export async function replace(name: Store, entries: [IDBValidKey, unknown][]): Promise<void> {
  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(name, "readwrite")
    const s = tx.objectStore(name)
    s.clear()
    for (const [key, value] of entries) s.put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

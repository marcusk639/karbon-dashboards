import { createPgliteDb } from "../../src/store/adapter.js";
import { openStore, type Store } from "../../src/store/db.js";

/** A fresh in-memory Postgres (PGlite) store: no server needed. */
export const memStore = async (): Promise<Store> => openStore(await createPgliteDb());

import { v7 as uuidv7 } from 'uuid';

/** UUIDv7, generated in the app for index locality. Never use auto-increment ids in URLs. */
export function newId() {
  return uuidv7();
}

import { ApiClient } from './api/ApiClient.js';
import { ConfigStore } from './state/ConfigStore.js';
import { ProjectStore } from './state/ProjectStore.js';

/** One instance of each store for the whole app. */
export const api = new ApiClient();
export const configStore = new ConfigStore(api);
export const projectStore = new ProjectStore(api);

/**
 * Messages the worker posts to the page. This will grow into the full vault
 * command/reply protocol; for now it only signals worker startup.
 */
export type WorkerToPage = {type: 'ready'};

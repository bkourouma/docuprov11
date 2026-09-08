/** Shared BullMQ contract between the API (producer) and the worker (consumer). */
export const ACQUISITION_QUEUE = 'acquisition';

/** DI token for the injectable acquisition Queue instance. */
export const ACQUISITION_QUEUE_TOKEN = 'ACQUISITION_QUEUE_TOKEN';

export interface AcquisitionJobData {
  batchId: number;
  /** true when re-running an existing batch (idempotent reprocess, FR-020). */
  reprocess?: boolean;
}

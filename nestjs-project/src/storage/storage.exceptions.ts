import { DomainException } from '../common/exceptions/domain.exception';

/** Transient storage failure (network, timeout, throttling or 5xx) in a storage operation. */
export class StorageUnavailableException extends DomainException {
  constructor(
    public readonly operation: string,
    cause?: unknown,
  ) {
    super('STORAGE_UNAVAILABLE', 503, 'Storage is temporarily unavailable');
    this.cause = cause;
  }
}

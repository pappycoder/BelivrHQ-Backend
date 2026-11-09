import { BadRequestException } from '@nestjs/common';

/** No provider transaction exists yet; this is not evidence of a failed or paid charge. */
export class PaymentVerificationPendingException extends BadRequestException {
  constructor() {
    super('No completed payment was found for this reference yet. Please check again shortly.');
  }
}

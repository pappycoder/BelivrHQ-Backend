import { BadRequestException } from '@nestjs/common';

/** Keep in step with the published web documents when introducing a new version. */
export const REGISTRATION_LEGAL_VERSION = '2026-10-24';

export function registrationLegalAcceptance(input: {
  termsAccepted?: boolean;
  acceptedTermsVersion?: string;
}) {
  // Older clients remain compatible; absence is never recorded as acceptance.
  if (input.termsAccepted === undefined && input.acceptedTermsVersion === undefined)
    return undefined;
  if (input.termsAccepted !== true || input.acceptedTermsVersion !== REGISTRATION_LEGAL_VERSION) {
    throw new BadRequestException('Accept the current BelivrHQ terms before creating an account');
  }
  return {
    termsOfServiceVersion: REGISTRATION_LEGAL_VERSION,
    websiteTermsVersion: REGISTRATION_LEGAL_VERSION,
    privacyNoticeVersion: REGISTRATION_LEGAL_VERSION,
    acceptedAt: new Date().toISOString(),
    source: 'registration',
  };
}

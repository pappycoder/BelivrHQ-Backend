# System email previews

Fictional examples of the shared ChurchOS email design. Run `npm run email:preview` to regenerate HTML. PNGs show local desktop browser renders with the repository's opaque logo asset.

| Email | HTML | Preview |
| --- | --- | --- |
| Welcome | [HTML](welcome.html) | [PNG](welcome.png) |
| Subscription activation | [HTML](activation.html) | [PNG](activation.png), [mobile](activation-mobile.png) |
| Subscription renewal | [HTML](renewal.html) | [PNG](renewal.png) |
| Plan upgrade | [HTML](upgrade.html) | [PNG](upgrade.png) |
| Staff invitation | [HTML](invitation.html) | [PNG](invitation.png) |
| Password reset | [HTML](password-reset.html) | [PNG](password-reset.png) |
| Sign-in code | [HTML](sign-in-code.html) | [PNG](sign-in-code.png) |
| Signup confirmation | [HTML](signup-confirmation.html) | [PNG](signup-confirmation.png) |
| Giving receipt | [HTML](giving-receipt.html) | [PNG](giving-receipt.png) |

The signup confirmation HTML is ready to upload to the Supabase Confirm signup template. Preserve `{{ .ConfirmationURL }}` exactly. Deploying backend code alone does not update that hosted template.

See [design and rollout notes](../../EMAIL-DESIGN-2026-11-09.md).

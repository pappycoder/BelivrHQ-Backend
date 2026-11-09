# Church-branded giving receipts

Receipt generation now passes the authenticated transaction church's ID, name and stored logo URL to the PDF renderer. The repeated header shows the church name and uploaded logo; header/footer and creator metadata retain BelivrHQ identity. The teal/lime/soft-green palette matches the frontend dashboard. Financial values, receipt references and existing branch/church permissions are unchanged.

The optional logo is accepted only from the configured `SUPABASE_URL` origin, inside `/storage/v1/object/public/{SUPABASE_STORAGE_BUCKET}/churches/{churchId}/`, with a raster image filename. The bucket defaults to `media`. Downloads reject redirects, time out after five seconds and stop above 2 MB. PNG/JPEG/WebP signatures and a 16-million-pixel decode limit apply before resizing to at most 256px and converting to PNG. Missing or failed logos fall back to the church name. No church-specific image is retained in a shared global cache.

ReceiptService uses the existing global ConfigService; there are no new environment variables, dependencies, migrations or permissions. Deploy the backend to apply receipt branding.

Validation: backend production build and targeted lint; 85 giving/receipt tests, including actual PDF generation with a WebP upload, failed-logo fallback and rejection of arbitrary origins, other churches' paths and oversized files.

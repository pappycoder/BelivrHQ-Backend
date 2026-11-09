export interface FlowStep {
  method: string;
  path: string;
  title: string;
  curl: string;
  response: string;
  note?: string;
}

export interface Flow {
  id: string;
  category: string;
  title: string;
  description: string;
  prerequisites?: string;
  businessRule?: string;
  steps: FlowStep[];
}

const ALL_FLOWS: Flow[] = [
  // ── Getting Started ──────────────────────────────────────────
  {
    id: 'authentication',
    category: 'Getting Started',
    title: 'Authentication',
    description:
      'The ChurchOS API uses Supabase Auth with JWT Bearer tokens. All protected endpoints require a valid token in the Authorization header. This flow covers the complete auth lifecycle: creating an account, logging in, refreshing expired tokens, and logging out.',
    prerequisites: 'None: registration is publicly accessible.',
    steps: [
      {
        method: 'POST',
        path: '/auth/register',
        title: 'Create an account',
        curl: `curl -X POST http://localhost:3001/api/v1/auth/register \\
  -H "Content-Type: application/json" \\
  -d '{
    "email": "pastor@mychurch.org",
    "password": "SecurePass123!",
    "firstName": "John",
    "lastName": "Doe",
    "churchName": "Victory Chapel",
    "role": "senior_pastor"
  }'`,
        response: `{
  "success": true,
  "data": {
    "user": { "id": "uuid", "email": "pastor@mychurch.org" },
    "profile": {
      "id": "uuid",
      "firstName": "John",
      "lastName": "Doe",
      "role": "senior_pastor"
    },
    "church": { "id": "uuid", "name": "Victory Chapel" },
    "session": {
      "access_token": "eyJhbGciOi...",
      "refresh_token": "eyJhbGciOi...",
      "expires_in": 3600
    }
  }
}`,
        note: 'Registration auto-creates a church, an admin profile, and returns a session token. The access_token expires in 1 hour.',
      },
      {
        method: 'POST',
        path: '/auth/login',
        title: 'Log in and get tokens',
        curl: `curl -X POST http://localhost:3001/api/v1/auth/login \\
  -H "Content-Type: application/json" \\
  -d '{
    "email": "pastor@mychurch.org",
    "password": "SecurePass123!"
  }'`,
        response: `{
  "success": true,
  "data": {
    "access_token": "eyJhbGciOi...",
    "refresh_token": "eyJhbGciOi...",
    "expires_in": 3600,
    "user": { "id": "uuid", "email": "pastor@mychurch.org" },
    "profile": {
      "id": "uuid",
      "firstName": "John",
      "lastName": "Doe",
      "role": "senior_pastor",
      "church_id": "uuid"
    }
  }
}`,
      },
      {
        method: '-',
        path: '-',
        title: 'Use the token in all subsequent requests',
        curl: `curl -X GET http://localhost:3001/api/v1/profiles/me \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": { "id": "uuid", "firstName": "John", ... }
}`,
        note: 'Include the Authorization header with Bearer scheme on every authenticated request. The token is verified against Supabase JWKS endpoints.',
      },
      {
        method: 'POST',
        path: '/auth/refresh',
        title: 'Refresh an expired token',
        curl: `curl -X POST http://localhost:3001/api/v1/auth/refresh \\
  -H "Content-Type: application/json" \\
  -d '{
    "refresh_token": "eyJhbGciOi..."
  }'`,
        response: `{
  "success": true,
  "data": {
    "access_token": "eyJhbGciOi...",
    "refresh_token": "eyJhbGciOi...",
    "expires_in": 3600
  }
}`,
        note: 'Call this endpoint when the access_token expires (HTTP 401). Store the new refresh_token for future refreshes.',
      },
      {
        method: 'POST',
        path: '/auth/logout',
        title: 'Log out and invalidate the session',
        curl: `curl -X POST http://localhost:3001/api/v1/auth/logout \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "message": "Logged out successfully"
}`,
        note: 'The token is blacklisted in Redis. Subsequent requests with the same token will be rejected.',
      },
    ],
  },

  // ── Core Entities ────────────────────────────────────────────
  {
    id: 'members',
    category: 'Core Entities',
    title: 'Member Onboarding',
    description:
      'The member registry is the heart of the platform. Every person in your church is represented as a Member record with contact info, demographics, status tracking, and optional branch assignment. This flow covers the full member lifecycle.',
    prerequisites: 'An authenticated session with church_admin or secretary role.',
    steps: [
      {
        method: 'POST',
        path: '/members',
        title: 'Create a new member',
        curl: `curl -X POST http://localhost:3001/api/v1/members \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "firstName": "Jane",
    "lastName": "Smith",
    "email": "jane@example.com",
    "phone": "+2348012345678",
    "gender": "female",
    "dateOfBirth": "1990-05-15",
    "branchId": "branch-uuid",
    "address": "12 Peace Avenue, Lagos"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "member-uuid",
    "firstName": "Jane",
    "lastName": "Smith",
    "email": "jane@example.com",
    "phone": "+2348012345678",
    "status": "active",
    "branchId": "branch-uuid",
    "createdAt": "2026-07-22T10:30:00.000Z"
  }
}`,
        note: 'Duplicate phone numbers within the same church are rejected. The member is created with status "active" by default.',
      },
      {
        method: 'GET',
        path: '/members',
        title: 'List members with search and filters',
        curl: `curl -X GET "http://localhost:3001/api/v1/members?page=1&limit=20&status=active&search=jane" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [{ "id": "member-uuid", "firstName": "Jane", ... }],
  "meta": { "total": 1, "page": 1, "limit": 20, "totalPages": 1 }
}`,
        note: "Supports search by name/email/phone, filter by status/branch/gender, and sort by any field. All queries are scoped to the authenticated user's church.",
      },
      {
        method: 'GET',
        path: '/members/:memberId',
        title: 'Get a single member with full details',
        curl: `curl -X GET http://localhost:3001/api/v1/members/member-uuid \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "id": "member-uuid",
    "firstName": "Jane",
    "lastName": "Smith",
    "status": "active",
    "givingHistory": [],
    "attendanceHistory": []
  }
}`,
      },
      {
        method: 'PATCH',
        path: '/members/:memberId',
        title: 'Update member details',
        curl: `curl -X PATCH http://localhost:3001/api/v1/members/member-uuid \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "phone": "+2348012345679",
    "status": "inactive"
  }'`,
        response: `{
  "success": true,
  "data": { "id": "member-uuid", "phone": "+2348012345679", "status": "inactive" }
}`,
        note: 'Partial updates only: send only the fields to change. A status change to "inactive" is a soft-delete.',
      },
      {
        method: 'DELETE',
        path: '/members/:memberId',
        title: 'Soft-delete a member',
        curl: `curl -X DELETE http://localhost:3001/api/v1/members/member-uuid \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "message": "Member deleted successfully"
}`,
        note: 'Members are soft-deleted (status → "inactive"). They can be restored via POST /members/:id/restore.',
      },
    ],
  },

  {
    id: 'attendance',
    category: 'Core Entities',
    title: 'Attendance Tracking',
    description:
      'Track service attendance with a two-step flow: first create a Service (e.g., "Sunday Morning Service"), then record attendance against it. Supports individual check-in, bulk import, visitor check-in, and trend analytics.',
    prerequisites:
      'Existing members in the system. At least one Service must be created before recording attendance.',
    steps: [
      {
        method: 'POST',
        path: '/services',
        title: 'Create a service',
        curl: `curl -X POST http://localhost:3001/api/v1/services \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Sunday Morning Service",
    "dayOfWeek": "Sunday",
    "startTime": "09:00",
    "endTime": "11:00",
    "branchId": "branch-uuid"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "service-uuid",
    "name": "Sunday Morning Service",
    "dayOfWeek": "Sunday",
    "startTime": "09:00",
    "endTime": "11:00",
    "isActive": true
  }
}`,
        note: 'Services are reusable templates. You create one Service (e.g., "Sunday Service") and record attendance against it week after week.',
      },
      {
        method: 'POST',
        path: '/attendance',
        title: 'Record a single check-in',
        curl: `curl -X POST http://localhost:3001/api/v1/attendance \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "serviceId": "service-uuid",
    "memberId": "member-uuid"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "attendance-uuid",
    "serviceId": "service-uuid",
    "memberId": "member-uuid",
    "checkedInAt": "2026-07-22T09:05:00.000Z"
  }
}`,
        note: 'Duplicate check-ins for the same member in the same service are rejected via a unique constraint on [service_id, member_id].',
      },
      {
        method: 'POST',
        path: '/attendance/bulk',
        title: 'Record bulk check-ins',
        curl: `curl -X POST http://localhost:3001/api/v1/attendance/bulk \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "serviceId": "service-uuid",
    "memberIds": ["member-uuid-1", "member-uuid-2", "member-uuid-3"]
  }'`,
        response: `{
  "success": true,
  "data": { "count": 3, "duplicates": 0 }
}`,
        note: 'Duplicate memberIds within the same service are silently skipped. Returns a count of successfully recorded entries.',
      },
      {
        method: 'GET',
        path: '/attendance/summary',
        title: 'Get attendance summary',
        curl: `curl -X GET "http://localhost:3001/api/v1/attendance/summary?startDate=2026-07-01&endDate=2026-07-31" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "totalCheckIns": 450,
    "uniqueMembers": 180,
    "averagePerService": 90,
    "byService": [
      { "serviceName": "Sunday Morning", "count": 120 },
      { "serviceName": "Wednesday Bible Study", "count": 65 }
    ]
  }
}`,
      },
    ],
  },

  {
    id: 'branches',
    category: 'Core Entities',
    title: 'Church & Branch Management',
    description:
      'Multi-campus churches can create multiple Branches under one Church account. Each branch has its own services, attendance, events, and optionally its own staff. One branch is designated as the headquarters.',
    prerequisites: 'An authenticated session with church_admin role.',
    steps: [
      {
        method: 'GET',
        path: '/church',
        title: 'Get church profile',
        curl: `curl -X GET http://localhost:3001/api/v1/church \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "id": "church-uuid",
    "name": "Victory Chapel",
    "denomination": "Pentecostal",
    "address": "123 Worship Street, Lagos",
    "phone": "+2348012345000",
    "email": "info@victorychapel.org"
  }
}`,
      },
      {
        method: 'POST',
        path: '/branches',
        title: 'Create a branch',
        curl: `curl -X POST http://localhost:3001/api/v1/branches \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Lagos Main Campus",
    "address": "42 Freedom Way, Lagos",
    "phone": "+2348012345678",
    "isHeadquarters": true
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "branch-uuid",
    "name": "Lagos Main Campus",
    "isHeadquarters": true
  }
}`,
        note: 'Only one branch per church can be marked as headquarters. The first branch is auto-set as headquarters.',
      },
      {
        method: 'GET',
        path: '/branches',
        title: 'List branches',
        curl: `curl -X GET http://localhost:3001/api/v1/branches \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    { "id": "branch-uuid", "name": "Lagos Main Campus", "isHeadquarters": true, "memberCount": 150 },
    { "id": "branch-uuid-2", "name": "Abuja Campus", "isHeadquarters": false, "memberCount": 80 }
  ]
}`,
      },
      {
        method: 'DELETE',
        path: '/branches/:branchId',
        title: 'Delete a branch',
        curl: `curl -X DELETE http://localhost:3001/api/v1/branches/branch-uuid \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "message": "Branch deleted successfully"
}`,
        note: 'Deletion is blocked if members are still assigned to the branch. Reassign or delete members first.',
      },
    ],
  },

  // ── Giving & Finance ─────────────────────────────────────────
  {
    id: 'digital-giving',
    category: 'Giving & Finance',
    title: 'Digital Giving (Paystack / Flutterwave)',
    description:
      'Accept digital payments through Paystack or Flutterwave. The flow is: initialize a payment → redirect the member to the gateway → handle the webhook callback → allow PDF receipt download. The default gateway is configured per-church.',
    prerequisites:
      'Configured PAYSTACK_SECRET_KEY or FLUTTERWAVE_SECRET_KEY in environment. Existing giving categories.',
    steps: [
      {
        method: 'GET',
        path: '/giving/categories',
        title: 'List giving categories',
        curl: `curl -X GET http://localhost:3001/api/v1/giving/categories \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    { "id": "cat-uuid", "name": "Tithe", "isActive": true },
    { "id": "cat-uuid-2", "name": "Offering", "isActive": true },
    { "id": "cat-uuid-3", "name": "Building Project", "isActive": true }
  ]
}`,
        note: 'Categories are configured by church_admin. At least one category must exist before taking payments.',
      },
      {
        method: 'POST',
        path: '/giving/categories',
        title: 'Create a giving category',
        curl: `curl -X POST http://localhost:3001/api/v1/giving/categories \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Missions Fund",
    "description": "Support for missionary work"
  }'`,
        response: `{
  "success": true,
  "data": { "id": "cat-uuid", "name": "Missions Fund", "isActive": true }
}`,
      },
      {
        method: 'POST',
        path: '/giving/initialize',
        title: 'Initialize a payment',
        curl: `curl -X POST http://localhost:3001/api/v1/giving/initialize \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "categoryId": "cat-uuid",
    "amount": 50000,
    "currency": "NGN",
    "gateway": "paystack",
    "memberId": "member-uuid"
  }'`,
        response: `{
  "success": true,
  "data": {
    "authorizationUrl": "https://checkout.paystack.com/abc123",
    "reference": "CHURCHOS-1712345678",
    "accessCode": "abc123",
    "transactionId": "txn-uuid"
  }
}`,
        note: 'The amount is in the smallest currency unit (kobo for NGN). Redirect the member to the authorizationUrl. The transaction is created in "pending" status.',
      },
      {
        method: 'POST',
        path: '/giving/webhook/paystack',
        title: 'Paystack webhook (server-side)',
        curl: `# This is called by Paystack, not by the frontend.
# Paystack sends a POST to this endpoint with the x-paystack-signature header.
# The server verifies the HMAC-SHA512 signature before processing.`,
        response: `{
  "success": true,
  "message": "Webhook processed"
}`,
        note: 'The webhook updates the transaction to "completed". The frontend should poll GET /giving/verify/:reference after redirect to check the status.',
      },
      {
        method: 'GET',
        path: '/giving/verify/:reference',
        title: 'Verify payment after redirect',
        curl: `curl -X GET http://localhost:3001/api/v1/giving/verify/CHURCHOS-1712345678 \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "status": "completed",
    "amount": 50000,
    "currency": "NGN",
    "gateway": "paystack",
    "categoryName": "Tithe",
    "paidAt": "2026-07-22T11:00:00.000Z"
  }
}`,
      },
      {
        method: 'GET',
        path: '/giving/transactions/:transactionId/receipt',
        title: 'Download PDF receipt',
        curl: `curl -X GET http://localhost:3001/api/v1/giving/transactions/txn-uuid/receipt \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -o receipt.pdf`,
        response: `# Binary PDF file. Save to disk with -o flag.
# The receipt includes: church name, member name, amount, category,
# transaction reference, payment date, and gateway.`,
        note: 'PDF receipts are only available for "completed" transactions. Receipt numbers follow the format YEAR/PREFIX/SEQUENTIAL (e.g., 2026/TIT/0001).',
      },
    ],
  },

  {
    id: 'cash-giving',
    category: 'Giving & Finance',
    title: 'Cash / Bank Transfer Giving',
    description:
      'Record offline giving (cash, bank transfers, or other non-digital payments) directly into the system. This is typically done by church administrators, secretaries, or treasurers.',
    prerequisites:
      'Existing giving categories. User must have treasurer, secretary, or church_admin role.',
    steps: [
      {
        method: 'POST',
        path: '/giving/cash',
        title: 'Record a cash/transfer giving',
        curl: `curl -X POST http://localhost:3001/api/v1/giving/cash \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "categoryId": "cat-uuid",
    "amount": 25000,
    "currency": "NGN",
    "memberId": "member-uuid",
    "paymentMethod": "cash",
    "notes": "Sunday service offering"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "txn-uuid",
    "amount": 25000,
    "paymentMethod": "cash",
    "status": "completed",
    "receiptNumber": "2026/OFF/0042"
  }
}`,
        note: 'Cash giving is immediately marked as "completed". A receipt number is auto-generated. The receipt PDF is available via the same /giving/transactions/:id/receipt endpoint.',
      },
      {
        method: 'GET',
        path: '/giving/transactions',
        title: 'List all transactions',
        curl: `curl -X GET "http://localhost:3001/api/v1/giving/transactions?page=1&limit=20&categoryId=cat-uuid" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    {
      "id": "txn-uuid",
      "amount": 25000,
      "paymentMethod": "cash",
      "status": "completed",
      "categoryName": "Offering",
      "memberName": "Jane Smith",
      "createdAt": "2026-07-22T12:00:00.000Z"
    }
  ],
  "meta": { "total": 42, "page": 1, "limit": 20, "totalPages": 3 }
}`,
        note: 'Supports filters by category, member, status, payment method, date range, and gateway.',
      },
    ],
  },

  {
    id: 'recurring-giving',
    category: 'Giving & Finance',
    title: 'Recurring Giving (Automated Charges)',
    description:
      'Allow members to set up recurring giving plans (weekly, monthly, quarterly). The system automatically charges their saved payment method on the next_charge_date via Paystack charge_authorization.',
    prerequisites:
      'The member must have completed at least one digital payment to save their authorization code.',
    steps: [
      {
        method: 'POST',
        path: '/giving/recurring',
        title: 'Create a recurring giving plan',
        curl: `curl -X POST http://localhost:3001/api/v1/giving/recurring \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "categoryId": "cat-uuid",
    "amount": 10000,
    "currency": "NGN",
    "frequency": "monthly",
    "memberId": "member-uuid"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "recurring-uuid",
    "amount": 10000,
    "frequency": "monthly",
    "nextChargeDate": "2026-08-22T00:00:00.000Z",
    "isActive": true
  }
}`,
        note: "A Paystack authorization_code is automatically captured from the member's most recent successful transaction. The next_charge_date is calculated based on frequency.",
      },
      {
        method: 'GET',
        path: '/giving/recurring',
        title: 'List recurring plans',
        curl: `curl -X GET http://localhost:3001/api/v1/giving/recurring \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [{
    "id": "recurring-uuid",
    "amount": 10000,
    "frequency": "monthly",
    "isActive": true,
    "nextChargeDate": "2026-08-22T00:00:00.000Z",
    "lastChargeDate": null
  }]
}`,
      },
      {
        method: 'PATCH',
        path: '/giving/recurring/:id/cancel',
        title: 'Cancel a recurring plan',
        curl: `curl -X PATCH http://localhost:3001/api/v1/giving/recurring/recurring-uuid/cancel \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "message": "Recurring giving cancelled"
}`,
        note: 'Cancellation sets is_active to false. No further charges are attempted. The plan is not deleted: it remains as a record.',
      },
    ],
  },

  {
    id: 'reports',
    category: 'Giving & Finance',
    title: 'Report Generation',
    description:
      'Generate financial, attendance, and member reports with date-range filtering. Reports aggregate data across the entire church. CSV export is available for offline analysis.',
    prerequisites: 'Sufficient data in the system (transactions, attendance records, members).',
    steps: [
      {
        method: 'GET',
        path: '/reports/financial',
        title: 'Get financial report',
        curl: `curl -X GET "http://localhost:3001/api/v1/reports/financial?startDate=2026-01-01&endDate=2026-07-22" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "totalGiving": 2500000,
    "averagePerTransaction": 12500,
    "byCategory": [
      { "category": "Tithe", "total": 1500000, "count": 60 },
      { "category": "Offering", "total": 600000, "count": 120 },
      { "category": "Building Project", "total": 400000, "count": 8 }
    ],
    "monthlyTrends": [
      { "month": "2026-01", "total": 350000 },
      { "month": "2026-02", "total": 420000 }
    ]
  }
}`,
      },
      {
        method: 'GET',
        path: '/reports/attendance',
        title: 'Get attendance report',
        curl: `curl -X GET "http://localhost:3001/api/v1/reports/attendance?startDate=2026-01-01&endDate=2026-07-22" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "totalAttendance": 5400,
    "averagePerService": 120,
    "byService": [
      { "serviceName": "Sunday Morning", "total": 3200, "average": 145 },
      { "serviceName": "Wednesday Bible Study", "total": 2200, "average": 85 }
    ],
    "monthlyTrends": [
      { "month": "2026-01", "total": 780 },
      { "month": "2026-02", "total": 810 }
    ]
  }
}`,
      },
      {
        method: 'POST',
        path: '/reports/export',
        title: 'Export report as CSV',
        curl: `curl -X POST http://localhost:3001/api/v1/reports/export \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "reportType": "financial",
    "startDate": "2026-01-01",
    "endDate": "2026-07-22",
    "format": "csv"
  }'`,
        response: `# Returns a CSV file download with Content-Type: text/csv
category,amount,count,percentage
Tithe,1500000,60,60.0
Offering,600000,120,24.0
Building Project,400000,8,16.0`,
      },
    ],
  },

  // ── Events & Sermons ─────────────────────────────────────────
  {
    id: 'free-events',
    category: 'Events & Sermons',
    title: 'Free Event Management',
    description:
      'Create and manage free events with registration tracking. Members can register and cancel their registration. Capacity limits are enforced to prevent over-registration.',
    prerequisites: 'An authenticated session. Existing members to register.',
    steps: [
      {
        method: 'POST',
        path: '/events',
        title: 'Create an event',
        curl: `curl -X POST http://localhost:3001/api/v1/events \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "title": "Youth Conference 2026",
    "description": "Annual youth gathering",
    "type": "conference",
    "startDate": "2026-08-15T09:00:00.000Z",
    "endDate": "2026-08-17T17:00:00.000Z",
    "location": "Victory Chapel Main Auditorium",
    "capacity": 500,
    "branchId": "branch-uuid"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "event-uuid",
    "title": "Youth Conference 2026",
    "capacity": 500,
    "registeredCount": 0,
    "isFree": true
  }
}`,
        note: 'Events without ticket tiers are "free" events. The capacity field limits total registrations.',
      },
      {
        method: 'POST',
        path: '/events/:eventId/register',
        title: 'Register a member',
        curl: `curl -X POST http://localhost:3001/api/v1/events/event-uuid/register \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{ "memberId": "member-uuid" }'`,
        response: `{
  "success": true,
  "data": {
    "id": "registration-uuid",
    "status": "confirmed"
  }
}`,
        note: 'Duplicate registration for the same member is rejected. If the event is at capacity (registeredCount >= capacity), registration is blocked.',
      },
      {
        method: 'DELETE',
        path: '/events/:eventId/register/:memberId',
        title: 'Cancel a registration',
        curl: `curl -X DELETE http://localhost:3001/api/v1/events/event-uuid/register/member-uuid \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "message": "Registration cancelled"
}`,
      },
    ],
  },

  {
    id: 'paid-events',
    category: 'Events & Sermons',
    title: 'Paid Event with Ticket Tiers',
    description:
      'Create paid events with multiple ticket tiers (e.g., Regular, VIP, Table). Members pay during registration via Paystack. Ticket validation is available for at-door check-in.',
    prerequisites:
      'Configured PAYSTACK_SECRET_KEY. Existing giving categories for ticket payments.',
    steps: [
      {
        method: 'POST',
        path: '/events',
        title: 'Create the event',
        curl: `curl -X POST http://localhost:3001/api/v1/events \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "title": "Leadership Summit 2026",
    "description": "Annual leadership training",
    "type": "conference",
    "startDate": "2026-09-10T08:00:00.000Z",
    "endDate": "2026-09-10T17:00:00.000Z",
    "location": "Victory Chapel Main Hall",
    "capacity": 200
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "event-uuid",
    "title": "Leadership Summit 2026",
    "isFree": false,
    "capacity": 200
  }
}`,
      },
      {
        method: 'POST',
        path: '/events/:eventId/tiers',
        title: 'Create ticket tiers',
        curl: `curl -X POST http://localhost:3001/api/v1/events/event-uuid/tiers \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "VIP",
    "price": 25000,
    "currency": "NGN",
    "quantity": 50,
    "description": "VIP seating with refreshments"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "tier-uuid",
    "name": "VIP",
    "price": 25000,
    "available": 50
  }
}`,
        note: 'Multiple tiers can be created per event. Each tier has its own price and quantity. The total event capacity is shared across tiers.',
      },
      {
        method: 'POST',
        path: '/events/:eventId/register',
        title: 'Register with tier selection',
        curl: `curl -X POST http://localhost:3001/api/v1/events/event-uuid/register \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "memberId": "member-uuid",
    "tierId": "tier-uuid"
  }'`,
        response: `{
  "success": true,
  "data": {
    "registrationId": "reg-uuid",
    "status": "pending_payment",
    "authorizationUrl": "https://checkout.paystack.com/xyz789",
    "reference": "CHURCHOS-EVT-1712345678"
  }
}`,
        note: 'For paid events, registration creates a "pending_payment" status. The member is redirected to the payment gateway. The registration confirms after successful payment.',
      },
      {
        method: 'POST',
        path: '/events/:eventId/webhook/paystack',
        title: 'Payment webhook (server-side)',
        curl: `# Called by Paystack when payment is completed.
# Automatically marks the registration as "confirmed"
# and creates a digital ticket with a unique validation code.`,
        response: `{
  "success": true,
  "message": "Payment confirmed"
}`,
        note: 'After successful payment, the registration status changes to "confirmed" and a ticket with a unique code is generated. The frontend can poll the event details to see the updated status.',
      },
      {
        method: 'POST',
        path: '/events/:eventId/tickets/validate',
        title: 'Validate a ticket at the door',
        curl: `curl -X POST http://localhost:3001/api/v1/events/event-uuid/tickets/validate \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{ "ticketCode": "TKT-ABC123" }'`,
        response: `{
  "success": true,
  "data": {
    "valid": true,
    "memberName": "Jane Smith",
    "tierName": "VIP",
    "checkedIn": true
  }
}`,
        note: 'Each paid ticket has a unique validation code. Validate at the door to prevent duplicate entries. The first validation marks the ticket as used.',
      },
    ],
  },

  {
    id: 'sermons',
    category: 'Events & Sermons',
    title: 'Sermons & Bookmarks',
    description:
      'Manage the sermon archive with search capabilities. Members can bookmark sermons for later reference. Audio URLs are managed after upload to Supabase Storage.',
    prerequisites: 'An authenticated session. Media upload capability (for audio files).',
    steps: [
      {
        method: 'POST',
        path: '/sermons',
        title: 'Create a sermon record',
        curl: `curl -X POST http://localhost:3001/api/v1/sermons \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "title": "Walking in Faith",
    "speaker": "Pastor John Doe",
    "series": "Faith Foundations",
    "date": "2026-07-20",
    "tags": ["faith", "foundations"],
    "description": "A message about trusting God in difficult times"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "sermon-uuid",
    "title": "Walking in Faith",
    "speaker": "Pastor John Doe",
    "series": "Faith Foundations",
    "date": "2026-07-20T00:00:00.000Z"
  }
}`,
      },
      {
        method: 'GET',
        path: '/sermons',
        title: 'Search and list sermons',
        curl: `curl -X GET "http://localhost:3001/api/v1/sermons?search=faith&speaker=Pastor+John&series=Faith+Foundations&page=1&limit=20" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    {
      "id": "sermon-uuid",
      "title": "Walking in Faith",
      "speaker": "Pastor John Doe",
      "date": "2026-07-20T00:00:00.000Z",
      "tags": ["faith", "foundations"],
      "audioUrl": null
    }
  ],
  "meta": { "total": 1, "page": 1, "limit": 20, "totalPages": 1 }
}`,
        note: 'Supports search by title/speaker, filter by series/tags, and date-range filtering.',
      },
      {
        method: 'POST',
        path: '/sermons/:sermonId/bookmark',
        title: 'Bookmark a sermon',
        curl: `curl -X POST http://localhost:3001/api/v1/sermons/sermon-uuid/bookmark \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "message": "Sermon bookmarked"
}`,
        note: 'A member can bookmark a sermon only once. Duplicate bookmark requests are rejected.',
      },
      {
        method: 'GET',
        path: '/sermons/bookmarks/me',
        title: 'List my bookmarks',
        curl: `curl -X GET http://localhost:3001/api/v1/sermons/bookmarks/me \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [{ "sermonId": "sermon-uuid", "title": "Walking in Faith", "bookmarkedAt": "2026-07-22T14:00:00.000Z" }]
}`,
      },
      {
        method: 'DELETE',
        path: '/sermons/:sermonId/bookmark',
        title: 'Remove a bookmark',
        curl: `curl -X DELETE http://localhost:3001/api/v1/sermons/sermon-uuid/bookmark \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "message": "Bookmark removed"
}`,
      },
    ],
  },

  // ── Communication ────────────────────────────────────────────
  {
    id: 'whatsapp',
    category: 'Communication',
    title: 'WhatsApp Integration',
    description:
      'Integrated with 360dialog for WhatsApp Business API. Handles webhook verification, inbound message processing with command routing (6 commands), outbound messaging, and template message sending.',
    prerequisites: 'Configured 360DIALOG_API_KEY and WHatsApp phone number ID in environment.',
    steps: [
      {
        method: 'GET',
        path: '/whatsapp/webhook',
        title: 'Webhook verification (360dialog setup)',
        curl: `# This is called by 360dialog during webhook setup.
# 360dialog sends a GET request with challenge parameters.
# The endpoint validates and returns the challenge token.`,
        response: `# Returns the challenge token text (not JSON)
abc123challengetoken`,
        note: 'This is a GET endpoint called by 360dialog during initial webhook configuration. You configure your 360dashboard to point to this URL.',
      },
      {
        method: 'POST',
        path: '/whatsapp/webhook',
        title: 'Inbound message processing',
        curl: `# Called by 360dialog when a member sends a message to your WhatsApp number.
# The system automatically processes the message and routes it:
# HELP → lists available commands
# CHECKIN → checks in for today's service
# GIVE → returns giving link
# PRAYER → logs prayer request
# EVENTS → lists upcoming events
# STATUS → shows 30-day attendance and giving summary`,
        response: `{
  "success": true,
  "message": "Webhook processed"
}`,
        note: 'Inbound messages are automatically routed to command handlers. If no command is recognized, a default help message is sent back.',
      },
      {
        method: 'POST',
        path: '/whatsapp/send',
        title: 'Send an outbound message',
        curl: `curl -X POST http://localhost:3001/api/v1/whatsapp/send \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "+2348012345678",
    "message": "Hello! God bless you. Join us this Sunday at 9 AM."
  }'`,
        response: `{
  "success": true,
  "data": {
    "messageId": "msg-uuid",
    "status": "queued"
  }
}`,
        note: 'Outbound messages are queued via BullMQ and delivered asynchronously. The message is logged in the Message table with direction "outbound".',
      },
      {
        method: 'POST',
        path: '/whatsapp/send-template',
        title: 'Send a template message',
        curl: `curl -X POST http://localhost:3001/api/v1/whatsapp/send-template \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "+2348012345678",
    "templateName": "service_reminder",
    "parameters": {
      "1": "John",
      "2": "Sunday",
      "3": "9:00 AM"
    }
  }'`,
        response: `{
  "success": true,
  "data": {
    "messageId": "msg-uuid",
    "status": "queued"
  }
}`,
        note: 'Template messages must be approved by WhatsApp and use registered HSM templates. Variables are interpolated using the parameters map.',
      },
    ],
  },

  {
    id: 'broadcasts',
    category: 'Communication',
    title: 'Broadcast Campaign',
    description:
      'Create targeted broadcast campaigns to specific audience segments. Messages are dispatched via channel-specific BullMQ queues (WhatsApp, SMS, Email). Audience filtering supports status, branch, gender, and search criteria.',
    prerequisites: 'Existing message templates. Configured WhatsApp/SMS/Email providers.',
    steps: [
      {
        method: 'POST',
        path: '/templates',
        title: 'Create a message template',
        curl: `curl -X POST http://localhost:3001/api/v1/templates \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Service Reminder",
    "channel": "whatsapp",
    "content": "Hi {{name}}, don\\'t forget our service this {{day}} at {{time}}. God bless you!",
    "category": "marketing",
    "variables": ["name", "day", "time"]
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "template-uuid",
    "name": "Service Reminder",
    "channel": "whatsapp",
    "status": "draft"
  }
}`,
        note: 'Templates have a status workflow: draft → published → archived. Only "published" templates can be used in broadcasts.',
      },
      {
        method: 'POST',
        path: '/broadcasts',
        title: 'Create a broadcast campaign',
        curl: `curl -X POST http://localhost:3001/api/v1/broadcasts \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "title": "Sunday Service Reminder",
    "templateId": "template-uuid",
    "channel": "whatsapp",
    "audienceFilter": {
      "status": ["active"],
      "branchId": "branch-uuid",
      "gender": "all"
    },
    "scheduledAt": "2026-07-25T08:00:00.000Z"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "broadcast-uuid",
    "title": "Sunday Service Reminder",
    "status": "scheduled",
    "estimatedRecipients": 150
  }
}`,
        note: 'The broadcast is created in "scheduled" status. At the scheduled time, messages are enqueued to the appropriate channel queue. You can cancel a broadcast before it starts.',
      },
      {
        method: 'GET',
        path: '/broadcasts/:broadcastId',
        title: 'Track broadcast status',
        curl: `curl -X GET http://localhost:3001/api/v1/broadcasts/broadcast-uuid \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "id": "broadcast-uuid",
    "status": "in_progress",
    "totalRecipients": 150,
    "sentCount": 98,
    "failedCount": 2,
    "progress": 65
  }
}`,
      },
    ],
  },

  // ── Pastoral & Admin ─────────────────────────────────────────
  {
    id: 'cell-groups',
    category: 'Pastoral & Admin',
    title: 'Cell Group Management',
    description:
      "Cell groups are small fellowship groups that meet in members' homes. They can be organized under Departments, have assigned leaders and assistants, track attendance, and provide geolocation-based recommendations using the Haversine formula.",
    prerequisites: 'An authenticated session with church_admin or senior_pastor role.',
    steps: [
      {
        method: 'POST',
        path: '/admin/departments',
        title: 'Create a department (optional grouping)',
        curl: `curl -X POST http://localhost:3001/api/v1/admin/departments \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Discipleship",
    "description": "Discipleship and small groups department",
    "headMemberId": "member-uuid"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "dept-uuid",
    "name": "Discipleship",
    "memberCount": 0
  }
}`,
        note: 'Departments are optional containers for cell groups. You can create cell groups without a department.',
      },
      {
        method: 'POST',
        path: '/admin/cell-groups',
        title: 'Create a cell group',
        curl: `curl -X POST http://localhost:3001/api/v1/admin/cell-groups \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Lagos Island Fellowship",
    "departmentId": "dept-uuid",
    "meetingDay": "Wednesday",
    "meetingTime": "17:00",
    "location": "12 Peace Avenue, Lagos",
    "latitude": 6.5244,
    "longitude": 3.3792,
    "description": "Mid-week fellowship on Lagos Island"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "cell-uuid",
    "name": "Lagos Island Fellowship",
    "memberCount": 0,
    "meetingDay": "Wednesday"
  }
}`,
        note: 'Latitude and longitude enable the nearest-group recommendation feature using the Haversine formula.',
      },
      {
        method: 'POST',
        path: '/admin/cell-groups/:id/members',
        title: 'Add members to a cell group',
        curl: `curl -X POST http://localhost:3001/api/v1/admin/cell-groups/cell-uuid/members \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "memberId": "member-uuid",
    "role": "member"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "cell-member-uuid",
    "memberId": "member-uuid",
    "role": "member"
  }
}`,
        note: 'Roles available: member (default), leader, assistant. A member can only belong to one cell group (unique constraint on member_id).',
      },
      {
        method: 'POST',
        path: '/admin/cell-groups/:id/attendance',
        title: 'Record cell group attendance',
        curl: `curl -X POST http://localhost:3001/api/v1/admin/cell-groups/cell-uuid/attendance \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "memberId": "member-uuid",
    "status": "present",
    "meetingDate": "2026-07-22"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "cell-attendance-uuid",
    "status": "present"
  }
}`,
        note: 'Status options: present, absent, excused. Unique constraint on [cell_group_id, member_id, meeting_date] prevents duplicate records.',
      },
      {
        method: 'GET',
        path: '/admin/cell-groups/nearest',
        title: 'Find nearest cell group',
        curl: `curl -X GET "http://localhost:3001/api/v1/admin/cell-groups/nearest?lat=6.5000&lng=3.3500" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    { "name": "Lagos Island Fellowship", "distance": 3.2, "meetingDay": "Wednesday", "memberCount": 12 },
    { "name": "Ikeja Connection Group", "distance": 8.1, "meetingDay": "Tuesday", "memberCount": 8 }
  ]
}`,
        note: 'Uses the Haversine formula to calculate great-circle distances. Results are sorted by proximity.',
      },
    ],
  },

  {
    id: 'pastoral-care',
    category: 'Pastoral & Admin',
    title: 'Pastoral Care & Scoring',
    description:
      'Comprehensive pastoral care module with AES-256-GCM encrypted notes, life event tracking, engagement scoring, and risk scoring. Confidentiality levels (standard/confidential/restricted) control access to sensitive notes.',
    prerequisites: 'An authenticated session. PASTORAL_ENCRYPTION_KEY configured in environment.',
    steps: [
      {
        method: 'POST',
        path: '/pastoral/notes',
        title: 'Create a pastoral note',
        curl: `curl -X POST http://localhost:3001/api/v1/pastoral/notes \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "memberId": "member-uuid",
    "content": "Member shared about job loss. Prayed together and scheduled follow-up for next week.",
    "type": "counseling",
    "confidentiality": "standard"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "note-uuid",
    "memberId": "member-uuid",
    "type": "counseling",
    "confidentiality": "standard",
    "createdAt": "2026-07-22T15:00:00.000Z"
  }
}`,
        note: 'Note content is encrypted at rest using AES-256-GCM. Confidentiality levels: standard (visible to all pastoral staff), confidential (visible to senior pastors+), restricted (requires dual-authorization to delete).',
      },
      {
        method: 'POST',
        path: '/pastoral/life-events',
        title: 'Track a life event',
        curl: `curl -X POST http://localhost:3001/api/v1/pastoral/life-events \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "memberId": "member-uuid",
    "type": "birthday",
    "title": "Jane Smith's Birthday",
    "eventDate": "2026-08-15"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "life-event-uuid",
    "type": "birthday",
    "eventDate": "2026-08-15T00:00:00.000Z"
  }
}`,
        note: 'Life event types: birthday, wedding, death, dedication, baptism, anniversary. The system can auto-generate greeting messages for upcoming events.',
      },
      {
        method: 'GET',
        path: '/pastoral/engagement',
        title: 'Get engagement scores',
        curl: `curl -X GET "http://localhost:3001/api/v1/pastoral/engagement?memberId=member-uuid" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "memberId": "member-uuid",
    "overallScore": 72,
    "components": {
      "attendance": 85,
      "giving": 60,
      "events": 70,
      "communication": 75,
      "consistency": 65
    },
    "level": "engaged"
  }
}`,
        note: 'Scores range from 0-100. Levels: low (0-33), moderate (34-66), engaged (67-100). Scores are recalculated nightly by the NightlyJobsProcessor.',
      },
      {
        method: 'GET',
        path: '/admin/dashboard',
        title: 'Pastoral dashboard',
        curl: `curl -X GET http://localhost:3001/api/v1/admin/dashboard \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "membersNeedingAttention": 12,
    "highRiskCount": 5,
    "engagementDistribution": {
      "engaged": 120,
      "moderate": 200,
      "low": 45
    },
    "risingStars": [
      { "memberId": "member-uuid", "name": "Jane Smith", "scoreChange": "+15" }
    ]
  }
}`,
        note: 'Dashboard provides a quick overview of member engagement health. Members with declining engagement or high risk scores appear in "needing attention".',
      },
    ],
  },

  {
    id: 'assets',
    category: 'Pastoral & Admin',
    title: 'Asset & Inventory Management',
    description:
      'Comprehensive asset management with categories, maintenance scheduling, depreciation tracking, loan management, QR code generation, and field audit scanning.',
    prerequisites: 'An authenticated session with appropriate role permissions.',
    steps: [
      {
        method: 'POST',
        path: '/assets/categories',
        title: 'Create an asset category',
        curl: `curl -X POST http://localhost:3001/api/v1/assets/categories \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Audio Equipment",
    "description": "Sound systems, microphones, speakers"
  }'`,
        response: `{
  "success": true,
  "data": { "id": "cat-uuid", "name": "Audio Equipment" }
}`,
      },
      {
        method: 'POST',
        path: '/assets',
        title: 'Create an asset',
        curl: `curl -X POST http://localhost:3001/api/v1/assets \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Yamaha Mixing Console",
    "categoryId": "cat-uuid",
    "assetTag": "AUD-001",
    "serialNumber": "YAMAHA-12345",
    "brand": "Yamaha",
    "model": "MG16XU",
    "condition": "good",
    "purchaseDate": "2025-01-15",
    "purchaseCost": 450000,
    "status": "in_use",
    "branchId": "branch-uuid",
    "custodianMemberId": "member-uuid",
    "location": "Main Auditorium Sound Booth"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "asset-uuid",
    "name": "Yamaha Mixing Console",
    "assetTag": "AUD-001",
    "status": "in_use"
  }
}`,
        note: 'Asset tags must be unique per church. Conditions: excellent, good, fair, poor. Statuses: in_use, in_storage, under_maintenance, decommissioned, lost, discarded.',
      },
      {
        method: 'POST',
        path: '/assets/:assetId/maintenance',
        title: 'Schedule maintenance',
        curl: `curl -X POST http://localhost:3001/api/v1/assets/asset-uuid/maintenance \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "type": "preventive",
    "description": "Quarterly cleaning and calibration",
    "scheduledDate": "2026-08-01",
    "cost": 25000,
    "vendor": "Yamaha Service Center"
  }'`,
        response: `{
  "success": true,
  "data": { "id": "maint-uuid", "status": "scheduled" }
}`,
        note: 'Maintenance statuses: scheduled, in_progress, completed, cancelled. When maintenance is scheduled, the asset status auto-changes to "under_maintenance".',
      },
      {
        method: 'POST',
        path: '/assets/:assetId/loans',
        title: 'Loan out an asset',
        curl: `curl -X POST http://localhost:3001/api/v1/assets/asset-uuid/loans \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "memberId": "member-uuid",
    "expectedReturnDate": "2026-08-05",
    "notes": "For youth conference"
  }'`,
        response: `{
  "success": true,
  "data": { "id": "loan-uuid", "status": "active" }
}`,
        note: 'When a loan is created, the asset status changes to "in_use". The loan must be returned via the return endpoint to complete the loan cycle.',
      },
      {
        method: 'POST',
        path: '/assets/:assetId/qr',
        title: 'Generate QR code data',
        curl: `curl -X POST http://localhost:3001/api/v1/assets/asset-uuid/qr \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "qrData": "CHURCHOS:ASSET:asset-uuid",
    "qrImageUrl": "https://api.qrserver.com/v1/create-qr-code/?data=CHURCHOS%3AASSET%3Aasset-uuid"
  }
}`,
        note: 'The QR code encodes a standard format: CHURCHOS:ASSET:<asset-id>. This can be scanned using the POST /assets/scan endpoint for field audits.',
      },
      {
        method: 'POST',
        path: '/assets/scan',
        title: 'Scan an asset QR code',
        curl: `curl -X POST http://localhost:3001/api/v1/assets/scan \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "qrData": "CHURCHOS:ASSET:asset-uuid",
    "location": "Main Auditorium"
  }'`,
        response: `{
  "success": true,
  "data": {
    "asset": {
      "name": "Yamaha Mixing Console",
      "status": "in_use",
      "condition": "good"
    },
    "activeLoan": null,
    "upcomingMaintenance": { "date": "2026-08-01", "type": "preventive" }
  }
}`,
        note: 'Scanning logs an audit trail in AssetScanLog. The response surfaces the current asset state, active loans (if any), and upcoming maintenance.',
      },
    ],
  },

  // ── Engagement ───────────────────────────────────────────────
  {
    id: 'forms',
    category: 'Engagement',
    title: 'Forms & Submission Workflow',
    description:
      'Build custom forms with various field types (text, number, date, dropdown, checkbox, textarea). Forms can be used internally (authenticated submissions) or publicly (anonymous submissions via public token). Submissions go through an approval workflow.',
    prerequisites: 'An authenticated session with form creation permissions.',
    steps: [
      {
        method: 'POST',
        path: '/forms',
        title: 'Create a form',
        curl: `curl -X POST http://localhost:3001/api/v1/forms \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "title": "Prayer Request Form",
    "description": "Submit your prayer requests to the pastoral team",
    "fields": [
      {
        "label": "Full Name",
        "type": "text",
        "required": true,
        "order": 1
      },
      {
        "label": "Prayer Request",
        "type": "textarea",
        "required": true,
        "order": 2
      },
      {
        "label": "Urgency",
        "type": "dropdown",
        "required": true,
        "options": ["Low", "Medium", "High", "Critical"],
        "order": 3
      }
    ],
    "isPublic": true
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "form-uuid",
    "title": "Prayer Request Form",
    "isPublic": true,
    "publicToken": "abc123def456",
    "fieldCount": 3
  }
}`,
        note: 'Public forms get a unique public_token. The public submission endpoint is at POST /forms/public/:publicToken/submit (no auth required).',
      },
      {
        method: 'POST',
        path: '/forms/:formId/submit',
        title: 'Submit a form (authenticated)',
        curl: `curl -X POST http://localhost:3001/api/v1/forms/form-uuid/submit \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "values": {
      "Full Name": "Jane Smith",
      "Prayer Request": "Praying for healing for my mother",
      "Urgency": "High"
    }
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "submission-uuid",
    "status": "pending"
  }
}`,
        note: 'Submissions start in "pending" status. They go through an approval workflow: pending → approved or rejected. Attachments can be uploaded as MediaAsset references.',
      },
      {
        method: 'PATCH',
        path: '/forms/:formId/submissions/:submissionId/approve',
        title: 'Approve or reject a submission',
        curl: `curl -X PATCH http://localhost:3001/api/v1/forms/form-uuid/submissions/submission-uuid/approve \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "action": "approve",
    "note": "Prayer request received, pastoral team will follow up"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "submission-uuid",
    "status": "approved",
    "approvedBy": "John Doe",
    "approvedAt": "2026-07-22T16:00:00.000Z"
  }
}`,
        note: 'Actions: approve or reject. Rejection requires a reason. Approved submissions can be used to trigger follow-up workflows.',
      },
    ],
  },

  {
    id: 'notifications',
    category: 'Engagement',
    title: 'In-App Notifications',
    description:
      'In-app notification system for informing members and staff about important events. Notifications have types (system, attendance, giving, event, pastoral, broadcast) and can be marked as read individually or in bulk.',
    prerequisites: 'An authenticated session.',
    steps: [
      {
        method: 'GET',
        path: '/notifications',
        title: 'List notifications',
        curl: `curl -X GET "http://localhost:3001/api/v1/notifications?page=1&limit=20&type=event" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    {
      "id": "notif-uuid",
      "type": "event",
      "title": "Youth Conference Reminder",
      "body": "Don\\'t forget the Youth Conference starts tomorrow at 9 AM",
      "readAt": null,
      "createdAt": "2026-07-21T10:00:00.000Z"
    }
  ],
  "meta": { "total": 5, "page": 1, "limit": 20, "totalPages": 1 }
}`,
        note: 'Notifications can be filtered by type (system, attendance, giving, event, pastoral, broadcast) and read status.',
      },
      {
        method: 'GET',
        path: '/notifications/unread-count',
        title: 'Get unread notification count',
        curl: `curl -X GET http://localhost:3001/api/v1/notifications/unread-count \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": { "count": 3 }
}`,
        note: 'Use this endpoint to show a badge on the notification icon in the frontend.',
      },
      {
        method: 'PATCH',
        path: '/notifications/:notificationId/read',
        title: 'Mark a notification as read',
        curl: `curl -X PATCH http://localhost:3001/api/v1/notifications/notif-uuid/read \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": { "id": "notif-uuid", "readAt": "2026-07-22T16:30:00.000Z" }
}`,
      },
      {
        method: 'PATCH',
        path: '/notifications/read-all',
        title: 'Mark all notifications as read',
        curl: `curl -X PATCH http://localhost:3001/api/v1/notifications/read-all \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": { "updatedCount": 3 }
}`,
      },
    ],
  },

  {
    id: 'webhooks',
    category: 'Engagement',
    title: 'Outbound Webhooks',
    description:
      'Subscribe to internal events and receive HTTP callbacks when they occur. Supports events like member.created, transaction.completed, etc. Deliveries include HMAC-SHA256 signed payloads with automatic retry (3 attempts, exponential backoff).',
    prerequisites:
      'An authenticated session with church_admin role for management. A publicly accessible endpoint URL on your side to receive webhooks.',
    steps: [
      {
        method: 'POST',
        path: '/webhooks',
        title: 'Create a webhook subscription',
        curl: `curl -X POST http://localhost:3001/api/v1/webhooks \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "url": "https://my-app.com/webhooks/churchos",
    "events": ["member.created", "transaction.completed"],
    "secret": "my-webhook-secret"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "webhook-uuid",
    "url": "https://my-app.com/webhooks/churchos",
    "events": ["member.created", "transaction.completed"],
    "isActive": true
  }
}`,
        note: 'The secret is used to sign the payload with HMAC-SHA256. Your endpoint receives the signature in the x-churchos-signature header. Verify it to ensure the request came from ChurchOS.',
      },
      {
        method: 'POST',
        path: '/webhooks/:id/test',
        title: 'Fire a test event',
        curl: `curl -X POST http://localhost:3001/api/v1/webhooks/webhook-uuid/test \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "event": "member.created",
    "payload": { "id": "test-uuid", "name": "Test Member" }
  }'`,
        response: `{
  "success": true,
  "data": {
    "deliveryId": "delivery-uuid",
    "status": "pending"
  }
}`,
        note: 'Use this endpoint to test your webhook integration. The delivery will be attempted immediately.',
      },
      {
        method: 'GET',
        path: '/webhooks/:id/deliveries',
        title: 'View delivery history',
        curl: `curl -X GET http://localhost:3001/api/v1/webhooks/webhook-uuid/deliveries \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    {
      "id": "delivery-uuid",
      "event": "member.created",
      "status": "success",
      "responseStatus": 200,
      "attempts": 1,
      "createdAt": "2026-07-22T17:00:00.000Z"
    },
    {
      "id": "delivery-uuid-2",
      "event": "transaction.completed",
      "status": "failed",
      "responseStatus": 500,
      "attempts": 3,
      "nextRetryAt": null,
      "createdAt": "2026-07-22T16:00:00.000Z"
    }
  ]
}`,
        note: 'Delivery status: pending, success, failed. Failed deliveries are retried up to 3 times with exponential backoff. After exhausting retries, the delivery is marked as failed and not retried again.',
      },
      {
        method: 'DELETE',
        path: '/webhooks/:id',
        title: 'Deactivate a webhook subscription',
        curl: `curl -X DELETE http://localhost:3001/api/v1/webhooks/webhook-uuid \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "message": "Webhook deactivated"
}`,
        note: 'Deactivation sets is_active to false. Future events will not be delivered. The subscription record and delivery history are preserved.',
      },
    ],
  },

  // ── Platform ─────────────────────────────────────────────────
  {
    id: 'photo-upload',
    category: 'Platform',
    title: 'Photo Upload & Management',
    description:
      'Upload profile photos, member photos, and other images. All images are automatically optimized via sharp (WebP conversion, 1200px max, quality 80). Old images are automatically deleted from Supabase Storage when replaced.',
    prerequisites: 'Configured SUPABASE_STORAGE_BUCKET and SUPABASE_* env vars.',
    steps: [
      {
        method: 'POST',
        path: '/media/upload/image',
        title: 'Upload an image',
        curl: `curl -X POST http://localhost:3001/api/v1/media/upload/image \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: multipart/form-data" \\
  -F "file=@/path/to/profile-photo.jpg"`,
        response: `{
  "success": true,
  "data": {
    "url": "https://supabase.co/storage/v1/object/public/media/profiles/uuid/image.webp",
    "assetId": "asset-uuid",
    "mimeType": "image/webp",
    "size": 24500
  }
}`,
        note: 'The image is converted to WebP format, resized to max 1200px, and EXIF metadata is stripped. The returned URL can be used directly in img tags.',
      },
      {
        method: 'PATCH',
        path: '/profiles/me/photo',
        title: 'Set profile photo',
        curl: `curl -X PATCH http://localhost:3001/api/v1/profiles/me/photo \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: multipart/form-data" \\
  -F "file=@/path/to/avatar.jpg"`,
        response: `{
  "success": true,
  "data": {
    "avatarUrl": "https://supabase.co/storage/v1/object/public/media/profiles/uuid/image.webp"
  }
}`,
        note: 'This endpoint handles the upload AND profile update in one call. The old avatar photo is automatically deleted from storage.',
      },
      {
        method: 'PATCH',
        path: '/members/:memberId',
        title: 'Set member photo URL',
        curl: `curl -X PATCH http://localhost:3001/api/v1/members/member-uuid \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "photoUrl": "https://supabase.co/storage/v1/object/public/media/profiles/uuid/image.webp"
  }'`,
        response: `{
  "success": true,
  "data": { "id": "member-uuid", "photoUrl": "https://supabase.co/storage/v1/object/public/media/..." }
}`,
        note: 'After uploading via /media/upload/image, set the returned URL on the member record. The old photo (if any) is deleted from storage.',
      },
    ],
  },

  {
    id: 'sync',
    category: 'Platform',
    title: 'Offline Sync (Mobile)',
    description:
      'Support offline-first mobile clients with cursor-based pull synchronization and idempotent push synchronization. Changes are resolved with last-writer-wins strategy based on client timestamps.',
    prerequisites: 'An authenticated session. Offline data collected on the mobile client.',
    steps: [
      {
        method: 'GET',
        path: '/sync/pull',
        title: 'Pull changes from server',
        curl: `curl -X GET "http://localhost:3001/api/v1/sync/pull?cursor=2026-07-22T00:00:00.000Z&limit=100" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "changes": [
      {
        "entityType": "member",
        "entityId": "member-uuid",
        "action": "update",
        "data": { "firstName": "Jane", "status": "active" },
        "serverTimestamp": "2026-07-22T10:30:00.000Z"
      }
    ],
    "nextCursor": "2026-07-22T11:00:00.000Z",
    "hasMore": true
  }
}`,
        note: 'The cursor is a timestamp. Pass the last serverTimestamp from the previous response as the cursor for the next pull. Set hasMore=false to stop pulling.',
      },
      {
        method: 'POST',
        path: '/sync/push',
        title: 'Push changes to server',
        curl: `curl -X POST http://localhost:3001/api/v1/sync/push \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "changes": [
      {
        "entityType": "member",
        "entityId": "member-uuid",
        "action": "update",
        "data": { "phone": "+2348012345679" },
        "clientTimestamp": "2026-07-22T09:00:00.000Z"
      }
    ]
  }'`,
        response: `{
  "success": true,
  "data": {
    "results": [
      {
        "entityId": "member-uuid",
        "status": "applied",
        "serverTimestamp": "2026-07-22T11:00:00.000Z"
      }
    ]
  }
}`,
        note: 'Idempotency: if the same entity_id + action combination has already been processed (based on clientTimestamp), the server skips it and returns the existing result. Conflict resolution uses last-writer-wins.',
      },
      {
        method: 'POST',
        path: '/sync/mark-synced',
        title: 'Mark items as synced',
        curl: `curl -X POST http://localhost:3001/api/v1/sync/mark-synced \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "entityIds": ["member-uuid", "member-uuid-2"]
  }'`,
        response: `{
  "success": true,
  "data": {
    "marked": 2
  }
}`,
        note: 'After the client has successfully applied pushed items, call this endpoint to acknowledge receipt. This prevents redundant sync operations.',
      },
    ],
  },

  // ── Authentication (cont.) ─────────────────────────────────────
  {
    id: '22',
    category: 'Authentication',
    title: 'User Registration & Login',
    description:
      'Register a new user account and authenticate via JWT token exchange. Covers the complete auth lifecycle with Supabase Auth.',
    prerequisites: 'None: registration is publicly accessible.',
    businessRule:
      'Registration creates both a Supabase auth user and a Profile record in a transaction. Login returns ES256-signed JWT verified via JWKS. Rate limit: 10 req/min.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/auth/register',
        title: 'Register a new user',
        curl: `curl -X POST https://api.churchos.com/api/v1/auth/register \\
  -H "Content-Type: application/json" \\
  -d '{
    "email": "chioma@example.com",
    "password": "SecureP@ss123",
    "firstName": "Chioma",
    "lastName": "Okeke",
    "phone": "+2348034567890"
  }'`,
        response: `{
  "success": true,
  "data": {
    "user": { "id": "a1b2c3d4-...", "email": "chioma@example.com" },
    "profile": { "id": "p9f8e7d6-...", "firstName": "Chioma", "lastName": "Okeke", "role": "secretary" },
    "session": { "access_token": "eyJhbGciOi...", "refresh_token": "eyJhbGciOi...", "expires_in": 3600 }
  }
}`,
        note: 'Registration auto-creates a Prisma Profile linked to the Supabase auth user. Church ID is extracted from invite or church selection flow.',
      },
      {
        method: 'POST',
        path: '/api/v1/auth/login',
        title: 'Log in',
        curl: `curl -X POST https://api.churchos.com/api/v1/auth/login \\
  -H "Content-Type: application/json" \\
  -d '{
    "email": "chioma@example.com",
    "password": "SecureP@ss123"
  }'`,
        response: `{
  "success": true,
  "data": {
    "access_token": "eyJhbGciOiJFUzI1NiIsImtpZCI6ImtpZDAwMSJ9...",
    "refresh_token": "rt_refresh_token_value",
    "expires_in": 3600,
    "user": { "id": "a1b2c3d4-...", "email": "chioma@example.com" },
    "profile": { "id": "p9f8e7d6-...", "firstName": "Chioma", "lastName": "Okeke", "role": "secretary", "church_id": "ch_abc123" }
  }
}`,
        note: 'Login uses Supabase signInWithPassword. The JWT is verified server-side via JWKS endpoint using jose library.',
      },
      {
        method: 'POST',
        path: '/api/v1/auth/refresh',
        title: 'Refresh session',
        curl: `curl -X POST https://api.churchos.com/api/v1/auth/refresh \\
  -H "Content-Type: application/json" \\
  -d '{
    "refreshToken": "rt_refresh_token_value"
  }'`,
        response: `{
  "success": true,
  "data": {
    "access_token": "eyJhbGciOiJFUzI1NiIsImtpZCI6ImtpZDAwMSJ9...",
    "refresh_token": "rt_new_refresh_token",
    "expires_in": 3600
  }
}`,
        note: 'Refresh tokens expire after 30 days. The old refresh token is invalidated on rotation.',
      },
    ],
  },
  {
    id: '23',
    category: 'Authentication',
    title: 'Password Management',
    description:
      'Handle password resets and authenticated password changes for church staff and members.',
    prerequisites:
      'User must be logged in for password change. Password recovery uses the company Resend sender and WEB_URL. Supabase signup confirmations require their own email-template and SMTP configuration.',
    businessRule:
      'Forgot-password always returns 200 to prevent email enumeration. Change-password verifies current password against Supabase before updating.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/auth/forgot-password',
        title: 'Request password reset',
        curl: `curl -X POST https://api.churchos.com/api/v1/auth/forgot-password \\
  -H "Content-Type: application/json" \\
  -d '{
    "email": "chioma@example.com"
  }'`,
        response: `{
  "success": true,
  "message": "If an account with that email exists, a password reset link has been sent."
}`,
        note: 'Always returns 200 to prevent email enumeration attacks.',
      },
      {
        method: 'PATCH',
        path: '/api/v1/auth/reset-password',
        title: 'Reset password with token',
        curl: `curl -X PATCH https://api.churchos.com/api/v1/auth/reset-password \\
  -H "Content-Type: application/json" \\
  -d '{
    "token": "reset_token_from_email",
    "newPassword": "NewSecureP@ss456"
  }'`,
        response: `{
  "success": true,
  "message": "Password reset successful."
}`,
        note: 'The token is obtained from the password reset email sent by Supabase Auth.',
      },
      {
        method: 'PUT',
        path: '/api/v1/auth/password',
        title: 'Change password (authenticated)',
        curl: `curl -X PUT https://api.churchos.com/api/v1/auth/password \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "currentPassword": "SecureP@ss123",
    "newPassword": "EvenMoreSecureP@ss789"
  }'`,
        response: `{
  "success": true,
  "message": "Password updated successfully."
}`,
        note: 'Verifies current password against Supabase before allowing the change. Logout all other sessions after password change.',
      },
    ],
  },
  {
    id: '24',
    category: 'Authentication',
    title: 'Session Logout & Token Revocation',
    description: 'Terminate active sessions and revoke JWT tokens to prevent further API access.',
    prerequisites: 'User must be authenticated with a valid JWT.',
    businessRule:
      'Tokens are blacklisted in Redis until their natural expiry. Rate limit: 10 req/min on auth endpoints.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/auth/logout',
        title: 'Logout',
        curl: `curl -X POST https://api.churchos.com/api/v1/auth/logout \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "message": "Logged out successfully."
}`,
        note: 'The JWT is added to a Redis blacklist with a TTL matching the token expiry. All subsequent requests with this token will be rejected.',
      },
    ],
  },

  // ── Profile (cont.) ───────────────────────────────────────────
  {
    id: '25',
    category: 'Profile',
    title: 'Profile Management',
    description:
      'Retrieve, update, and manage user profiles within the church scope. Includes photo upload with automatic WebP optimization.',
    prerequisites: 'User must be authenticated. JWT must contain valid church_id claim.',
    businessRule:
      'Profiles are scoped by church_id from JWT. Partial updates only affect provided fields. Photos are optimized to WebP (quality 80, max 1200px). Old avatar is deleted when replaced.',
    steps: [
      {
        method: 'GET',
        path: '/api/v1/profiles/me',
        title: 'Get my profile',
        curl: `curl -X GET https://api.churchos.com/api/v1/profiles/me \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "id": "p9f8e7d6-...",
    "firstName": "Chioma",
    "lastName": "Okeke",
    "email": "chioma@example.com",
    "phone": "+2348034567890",
    "role": "secretary",
    "avatarUrl": "https://storage.churchos.com/avatars/p9f8e7d6.webp",
    "church": { "id": "ch_abc123", "name": "RCCG Victory Chapel" },
    "branch": { "id": "br_001", "name": "Ikeja Main Parish" },
    "createdAt": "2026-07-20T08:30:00+01:00"
  }
}`,
        note: 'Returns full profile with related church and branch details from the JWT church_id claim.',
      },
      {
        method: 'PATCH',
        path: '/api/v1/profiles/me',
        title: 'Update my profile',
        curl: `curl -X PATCH https://api.churchos.com/api/v1/profiles/me \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "firstName": "Chioma",
    "lastName": "Okafor",
    "phone": "+2348098765432"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "p9f8e7d6-...",
    "firstName": "Chioma",
    "lastName": "Okafor",
    "phone": "+2348098765432",
    "updatedAt": "2026-07-21T10:15:00+01:00"
  }
}`,
        note: 'Only provided fields are updated. Null or undefined fields are ignored.',
      },
      {
        method: 'POST',
        path: '/api/v1/profiles/me/photo',
        title: 'Upload profile photo',
        curl: `curl -X POST https://api.churchos.com/api/v1/profiles/me/photo \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -F "photo=@/home/user/profile-photo.jpg"`,
        response: `{
  "success": true,
  "data": {
    "avatarUrl": "https://storage.churchos.com/avatars/p9f8e7d6.webp",
    "dimensions": { "width": 1200, "height": 1200 },
    "size": 84500
  },
  "message": "Photo uploaded successfully"
}`,
        note: 'Image is converted to WebP via sharp (quality 80, max 1200x1200). Previous avatar is deleted from Supabase Storage.',
      },
    ],
  },
  {
    id: '26',
    category: 'Profile',
    title: 'Profile Listing & Role Management',
    description:
      'Search, filter, and manage church staff profiles. Update user roles with appropriate authorization checks.',
    prerequisites: 'Role updates require admin role (super_admin, senior_pastor, or church_admin).',
    businessRule:
      'Valid roles: super_admin, senior_pastor, church_admin, branch_pastor, secretary, treasurer, usher, department_head, cell_leader. Self-demotion and super_admin modification are blocked.',
    steps: [
      {
        method: 'GET',
        path: '/api/v1/profiles',
        title: 'List profiles with filters',
        curl: `curl -X GET "https://api.churchos.com/api/v1/profiles?search=Chioma&role=secretary&branch=br_001&page=1&limit=20&sort=lastName&order=asc" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    { "id": "p9f8e7d6-...", "firstName": "Chioma", "lastName": "Okafor", "email": "chioma@example.com", "role": "secretary" }
  ],
  "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}`,
        note: 'Supports search by name/phone, filter by role/branch, and sort by any column.',
      },
      {
        method: 'PATCH',
        path: '/api/v1/profiles/:profileId/role',
        title: 'Update user role',
        curl: `curl -X PATCH https://api.churchos.com/api/v1/profiles/p9f8e7d6-.../role \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "role": "treasurer"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "p9f8e7d6-...",
    "firstName": "Chioma",
    "lastName": "Okafor",
    "role": "treasurer",
    "updatedAt": "2026-07-21T11:00:00+01:00"
  }
}`,
        note: 'Self-demotion is rejected. super_admin role cannot be modified by anyone.',
      },
      {
        method: 'DELETE',
        path: '/api/v1/profiles/:profileId',
        title: 'Soft-delete profile',
        curl: `curl -X DELETE https://api.churchos.com/api/v1/profiles/p9f8e7d6-... \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "message": "Profile deactivated successfully."
}`,
        note: 'Soft-delete sets role to "removed" rather than deleting the record. Prevents self-deactivation.',
      },
    ],
  },

  // ── Members (cont.) ──────────────────────────────────────────
  {
    id: '27',
    category: 'Members',
    title: 'Member Details & History',
    description:
      'View full member profiles with aggregated giving, attendance, event, and pastoral history. Manage internal admin notes.',
    prerequisites: 'Member record must exist in the same church.',
    businessRule:
      'History queries aggregate from giving, attendance, events, and pastoral tables. Notes are visible only to admin roles and are audit-logged.',
    steps: [
      {
        method: 'GET',
        path: '/api/v1/members/:memberId',
        title: 'Get member with history',
        curl: `curl -X GET https://api.churchos.com/api/v1/members/mem_001234 \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "id": "mem_001234",
    "firstName": "Chioma",
    "lastName": "Okafor",
    "status": "active",
    "joinDate": "2024-01-15",
    "department": "Choir",
    "giving": { "totalTithe": 245000, "totalOfferings": 87500, "lastGift": { "date": "2026-07-14", "amount": 15000, "type": "tithe" } },
    "attendance": { "totalServices": 42, "lastService": "2026-07-20", "percentage": 87.5 },
    "events": [{ "name": "Annual Conference 2026", "date": "2026-06-10" }],
    "pastoral": { "lastVisit": "2026-06-28", "notesCount": 3 }
  }
}`,
        note: 'Returns aggregated data from multiple tables. Gives a complete pastoral view of the member.',
      },
      {
        method: 'GET',
        path: '/api/v1/members/:memberId/notes',
        title: 'List admin notes',
        curl: `curl -X GET https://api.churchos.com/api/v1/members/mem_001234/notes \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    { "id": "note_001", "content": "Requested prayer for family health issues.", "author": { "name": "Pastor Emeka" }, "category": "pastoral", "createdAt": "2026-06-28T14:30:00+01:00" }
  ],
  "meta": { "page": 1, "limit": 20, "total": 2, "totalPages": 1 }
}`,
        note: 'Notes are only visible to admin roles. Each note is audit-logged on creation.',
      },
      {
        method: 'POST',
        path: '/api/v1/members/:memberId/notes',
        title: 'Add admin note',
        curl: `curl -X POST https://api.churchos.com/api/v1/members/mem_001234/notes \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "content": "Discussed upcoming baptism class attendance.",
    "category": "pastoral"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "note_003",
    "content": "Discussed upcoming baptism class attendance.",
    "author": { "id": "a1b2c3d4-...", "name": "Pastor Emeka" },
    "category": "pastoral",
    "createdAt": "2026-07-21T12:00:00+01:00"
  }
}`,
        note: 'Categories include: pastoral, administrative, financial, event.',
      },
    ],
  },
  {
    id: '28',
    category: 'Members',
    title: 'Member Data Export',
    description:
      'Export member data as CSV or XLSX with configurable field selection and filters for offline analysis.',
    prerequisites: 'Export requires church_admin or senior_pastor role.',
    businessRule:
      'Supports CSV and XLSX formats. Filters include status, branch, gender, date range. Large exports (>10000 records) are processed asynchronously via BullMQ.',
    steps: [
      {
        method: 'GET',
        path: '/api/v1/members/export',
        title: 'Export members',
        curl: `curl -X GET "https://api.churchos.com/api/v1/members/export?format=csv&fields=firstName,lastName,email,phone,status,branch&status=active&page=1&limit=5000" \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Accept: text/csv"`,
        response: `firstName,lastName,email,phone,status,branch
Chioma,Okafor,chioma@example.com,+2348098765432,active,Ikeja Main Parish
Emeka,Nwosu,emeka@example.com,+2348022334455,active,Surulere Chapel`,
        note: 'For XLSX format, set format=xlsx and Accept: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.',
      },
    ],
  },

  // ── Attendance (cont.) ───────────────────────────────────────
  {
    id: '29',
    category: 'Attendance',
    title: 'Service Management',
    description:
      'Create, list, and update church service schedules for attendance tracking across branches.',
    prerequisites: 'Service day_of_week uses 0=Sunday through 6=Saturday format.',
    businessRule:
      'Services are scoped by church_id. Multiple services can exist per day (e.g., 8AM and 10AM Sunday). Cannot delete a service with attendance records.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/attendance/services',
        title: 'Create service',
        curl: `curl -X POST https://api.churchos.com/api/v1/attendance/services \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Sunday First Service",
    "day_of_week": 0,
    "start_time": "08:00",
    "end_time": "10:00",
    "branch_id": "br_001"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "srv_001",
    "name": "Sunday First Service",
    "dayOfWeek": 0,
    "startTime": "08:00",
    "endTime": "10:00",
    "branchId": "br_001"
  }
}`,
        note: 'day_of_week: 0=Sunday, 1=Monday, ..., 6=Saturday.',
      },
      {
        method: 'GET',
        path: '/api/v1/attendance/services',
        title: 'List services',
        curl: `curl -X GET https://api.churchos.com/api/v1/attendance/services?branch_id=br_001 \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    { "id": "srv_001", "name": "Sunday First Service", "dayOfWeek": 0, "startTime": "08:00" },
    { "id": "srv_002", "name": "Sunday Second Service", "dayOfWeek": 0, "startTime": "10:30" },
    { "id": "srv_003", "name": "Wednesday Bible Study", "dayOfWeek": 3, "startTime": "18:00" }
  ]
}`,
        note: 'Results can be filtered by branch_id and day_of_week.',
      },
      {
        method: 'PATCH',
        path: '/api/v1/attendance/services/:serviceId',
        title: 'Update service',
        curl: `curl -X PATCH https://api.churchos.com/api/v1/attendance/services/srv_001 \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Sunday First Service (updated)",
    "start_time": "07:30"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "srv_001",
    "name": "Sunday First Service (updated)",
    "startTime": "07:30",
    "updatedAt": "2026-07-21T14:00:00+01:00"
  }
}`,
        note: 'Only provided fields are updated.',
      },
    ],
  },
  {
    id: '30',
    category: 'Attendance',
    title: 'Check-In & Attendance Recording',
    description:
      'Record member attendance for services. Supports single, bulk, and walk-in visitor check-in workflows.',
    prerequisites: 'Service must exist and be active in the church.',
    businessRule:
      'Duplicate check-in prevention via unique constraint on (service_id, member_id). Visitor check-in creates a temporary member record with minimal fields.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/attendance',
        title: 'Single member check-in',
        curl: `curl -X POST https://api.churchos.com/api/v1/attendance \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "service_id": "srv_001",
    "member_id": "mem_001234"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "att_001",
    "serviceId": "srv_001",
    "memberId": "mem_001234",
    "checkedInAt": "2026-07-20T08:15:00+01:00"
  }
}`,
        note: 'Returns 409 Conflict if member already checked into this service.',
      },
      {
        method: 'POST',
        path: '/api/v1/attendance/bulk',
        title: 'Bulk check-in',
        curl: `curl -X POST https://api.churchos.com/api/v1/attendance/bulk \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "service_id": "srv_001",
    "member_ids": ["mem_001234", "mem_001235", "mem_001236"]
  }'`,
        response: `{
  "success": true,
  "data": {
    "checkedIn": 3,
    "duplicates": 0,
    "failed": 0
  }
}`,
        note: 'Bulk check-in skips duplicates silently and returns a summary count.',
      },
      {
        method: 'POST',
        path: '/api/v1/attendance/visitor',
        title: 'Visitor check-in',
        curl: `curl -X POST https://api.churchos.com/api/v1/attendance/visitor \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "service_id": "srv_001",
    "first_name": "Amara",
    "last_name": "Uche",
    "phone": "+2347066112233",
    "email": "amara@example.com"
  }'`,
        response: `{
  "success": true,
  "data": {
    "memberId": "mem_visit_001",
    "attendanceId": "att_002",
    "isNewMember": true,
    "checkedInAt": "2026-07-20T09:00:00+01:00"
  }
}`,
        note: 'Visitor check-in creates a minimal member record with status "visitor" for follow-up.',
      },
    ],
  },
  {
    id: '31',
    category: 'Attendance',
    title: 'Attendance Analytics & Trends',
    description: 'View attendance summaries and trends with daily, weekly, and monthly grouping.',
    prerequisites: 'Attendance records must exist for the queried period.',
    businessRule:
      'Trends support daily, weekly, and monthly grouping. Summary shows total check-ins, unique attendees, and first-time vs returning breakdown.',
    steps: [
      {
        method: 'GET',
        path: '/api/v1/attendance/summary',
        title: 'Attendance summary',
        curl: `curl -X GET "https://api.churchos.com/api/v1/attendance/summary?start_date=2026-07-01&end_date=2026-07-31" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "totalCheckIns": 1240,
    "uniqueMembers": 486,
    "avgPerService": 124,
    "firstTimers": 28,
    "returning": 458
  }
}`,
        note: 'Summary aggregates across all services for the church within the date range.',
      },
      {
        method: 'GET',
        path: '/api/v1/attendance/trends',
        title: 'Attendance trends',
        curl: `curl -X GET "https://api.churchos.com/api/v1/attendance/trends?start_date=2026-01-01&end_date=2026-07-31&group_by=month" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    { "period": "2026-01", "checkIns": 480, "uniqueMembers": 320 },
    { "period": "2026-02", "checkIns": 450, "uniqueMembers": 310 },
    { "period": "2026-07", "checkIns": 1240, "uniqueMembers": 486 }
  ]
}`,
        note: 'group_by supports: daily, weekly, monthly.',
      },
      {
        method: 'GET',
        path: '/api/v1/attendance/by-service/:serviceId',
        title: 'Service attendance detail',
        curl: `curl -X GET https://api.churchos.com/api/v1/attendance/by-service/srv_001 \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "totalCheckIns": 187,
    "attendees": [
      { "id": "mem_001234", "firstName": "Chioma", "lastName": "Okafor", "checkedInAt": "08:15" }
    ]
  }
}`,
        note: 'Returns the full list of attendees with check-in times for a specific service.',
      },
    ],
  },

  // ── Branches (cont.) ─────────────────────────────────────────
  {
    id: '32',
    category: 'Branches',
    title: 'Branch Deletion & Multi-Tenant Scoping',
    description:
      'Delete church branches with safety checks and understand how branch scoping works for multi-tenant data isolation.',
    prerequisites: 'Branch must exist. Church_admin or senior_pastor role required.',
    businessRule:
      'Branch deletion is blocked if any members are assigned to the branch. All queries are scoped by church_id for tenant isolation.',
    steps: [
      {
        method: 'DELETE',
        path: '/api/v1/branches/:branchId',
        title: 'Delete branch',
        curl: `curl -X DELETE https://api.churchos.com/api/v1/branches/br_001 \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "message": "Branch deleted successfully."
}`,
        note: 'Returns 409 Conflict if members exist in this branch. Reassign members before deleting.',
      },
    ],
  },

  // ── Church ────────────────────────────────────────────────────
  {
    id: '33',
    category: 'Church',
    title: 'Church Configuration & Settings',
    description:
      'Manage church-level configuration including payment gateway, WhatsApp settings, branding, and feature toggles.',
    prerequisites: 'Church must exist. Church_admin or senior_pastor role required.',
    businessRule:
      'Config is stored as key-value pairs. Default payment gateway can be paystack or flutterwave. Changes are audit-logged.',
    steps: [
      {
        method: 'GET',
        path: '/api/v1/church/config',
        title: 'Get church configuration',
        curl: `curl -X GET https://api.churchos.com/api/v1/church/config \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "default_payment_gateway": "paystack",
    "whatsapp_phone_number": "+2348030001000",
    "whatsapp_business_name": "RCCG Victory Chapel",
    "currency": "NGN",
    "timezone": "Africa/Lagos",
    "locale": "en-NG"
  }
}`,
        note: 'Config values are used as defaults across the platform. Church-specific overrides take precedence over system defaults.',
      },
      {
        method: 'PATCH',
        path: '/api/v1/church/config',
        title: 'Update church configuration',
        curl: `curl -X PATCH https://api.churchos.com/api/v1/church/config \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "default_payment_gateway": "flutterwave",
    "currency": "NGN"
  }'`,
        response: `{
  "success": true,
  "data": {
    "default_payment_gateway": "flutterwave",
    "currency": "NGN"
  },
  "message": "Configuration updated."
}`,
        note: 'Only provided fields are updated. Valid payment gateways: paystack, flutterwave.',
      },
    ],
  },
  {
    id: '34',
    category: 'Church',
    title: 'Staff Invitation & Management',
    description:
      'Invite new staff members via email, manage staff roles, and remove staff from the church.',
    prerequisites: 'Requires church_admin or senior_pastor role.',
    businessRule:
      'Invitations use Supabase admin invite API. Staff listing supports pagination, search by name/email, and role/branch filtering.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/church/invite',
        title: 'Invite staff member',
        curl: `curl -X POST https://api.churchos.com/api/v1/church/invite \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "email": "newstaff@example.com",
    "role": "secretary",
    "firstName": "Amara",
    "lastName": "Okafor",
    "branch_id": "br_001"
  }'`,
        response: `{
  "success": true,
  "data": {
    "invitedEmail": "newstaff@example.com",
    "profileId": "p_new_001",
    "role": "secretary"
  },
  "message": "Invitation email sent."
}`,
        note: 'Invitation sends an email via Supabase Auth. The user must accept the invite to activate their account.',
      },
      {
        method: 'GET',
        path: '/api/v1/church/staff',
        title: 'List staff members',
        curl: `curl -X GET "https://api.churchos.com/api/v1/church/staff?search=Amara&role=secretary&page=1&limit=20" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    { "id": "p_new_001", "email": "newstaff@example.com", "firstName": "Amara", "lastName": "Okafor", "role": "secretary", "branchId": "br_001", "status": "active" }
  ],
  "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}`,
        note: 'Status can be: active, invited, removed. Invited status means the user has not yet accepted.',
      },
      {
        method: 'PATCH',
        path: '/api/v1/church/staff/:profileId/role',
        title: 'Update staff role',
        curl: `curl -X PATCH https://api.churchos.com/api/v1/church/staff/p_new_001/role \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "role": "treasurer"
  }'`,
        response: `{
  "success": true,
  "data": { "id": "p_new_001", "role": "treasurer", "updatedAt": "2026-07-21T14:00:00+01:00" }
}`,
        note: 'Cannot modify super_admin role. Self-demotion is blocked.',
      },
      {
        method: 'DELETE',
        path: '/api/v1/church/staff/:profileId',
        title: 'Remove staff',
        curl: `curl -X DELETE https://api.churchos.com/api/v1/church/staff/p_new_001 \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "message": "Staff member removed."
}`,
        note: 'Soft-delete: role is set to "removed". The profile is retained for audit/history.',
      },
    ],
  },

  // ── Giving (cont.) ───────────────────────────────────────────
  {
    id: '35',
    category: 'Giving',
    title: 'Recurring Giving Setup',
    description:
      'Set up automated recurring giving schedules using saved payment authorization codes. Members can schedule weekly, bi-weekly, or monthly tithes and offerings.',
    prerequisites:
      'Member must have completed at least one successful digital payment to have a stored authorization code.',
    businessRule:
      'Recurring schedules are processed nightly by BullMQ RecurringGivingProcessor. Authorization codes are stored from successful Paystack/Flutterwave transactions.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/giving/recurring',
        title: 'Create recurring schedule',
        curl: `curl -X POST https://api.churchos.com/api/v1/giving/recurring \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "category_id": "cat_tithe",
    "amount": 25000,
    "frequency": "monthly",
    "day_of_month": 1,
    "start_date": "2026-08-01"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "rec_001",
    "categoryId": "cat_tithe",
    "amount": 25000,
    "frequency": "monthly",
    "dayOfMonth": 1,
    "startDate": "2026-08-01",
    "status": "active",
    "nextChargeDate": "2026-08-01"
  }
}`,
        note: 'Frequency options: weekly, bi-weekly, monthly. At least one successful Paystack/Flutterwave payment with authorization_code must exist.',
      },
      {
        method: 'GET',
        path: '/api/v1/giving/recurring',
        title: 'List recurring schedules',
        curl: `curl -X GET "https://api.churchos.com/api/v1/giving/recurring?status=active" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    { "id": "rec_001", "categoryId": "cat_tithe", "amount": 25000, "frequency": "monthly", "status": "active", "nextChargeDate": "2026-08-01" }
  ],
  "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}`,
        note: 'Filter by status: active, paused, cancelled.',
      },
      {
        method: 'GET',
        path: '/api/v1/giving/recurring/:id',
        title: 'Get recurring schedule',
        curl: `curl -X GET https://api.churchos.com/api/v1/giving/recurring/rec_001 \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "id": "rec_001",
    "categoryId": "cat_tithe",
    "amount": 25000,
    "frequency": "monthly",
    "status": "active",
    "lastChargeDate": "2026-08-01",
    "lastChargeStatus": "success",
    "totalCharged": 75000,
    "nextChargeDate": "2026-09-01"
  }
}`,
        note: 'Returns detailed history including last charge status and total amount collected.',
      },
      {
        method: 'PATCH',
        path: '/api/v1/giving/recurring/:id/cancel',
        title: 'Cancel recurring schedule',
        curl: `curl -X PATCH https://api.churchos.com/api/v1/giving/recurring/rec_001/cancel \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "message": "Recurring giving schedule cancelled."
}`,
        note: 'Cancellation is reversible by re-activating through the update endpoint.',
      },
    ],
  },
  {
    id: '36',
    category: 'Giving',
    title: 'Transaction Listing & Filtering',
    description:
      'Query and filter giving transactions with pagination. Supports filtering by category, member, status, type, date range, and payment gateway.',
    prerequisites: 'Transactions must exist in the church scope.',
    businessRule:
      'Transactions are immutable once their status is finalized (success, failed). Only pending transactions can be modified. All queries scoped by church_id.',
    steps: [
      {
        method: 'GET',
        path: '/api/v1/giving/transactions',
        title: 'List transactions',
        curl: `curl -X GET "https://api.churchos.com/api/v1/giving/transactions?category=cat_tithe&status=success&start_date=2026-01-01&end_date=2026-07-31&page=1&limit=20&sort=createdAt&order=desc" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    { "id": "txn_001", "memberName": "Chioma Okafor", "category": "Tithe", "amount": 50000, "type": "digital", "gateway": "paystack", "status": "success", "createdAt": "2026-07-20T10:00:00+01:00" }
  ],
  "meta": { "page": 1, "limit": 20, "total": 45, "totalPages": 3 }
}`,
        note: 'Filters: category_id, member_id, status (success/pending/failed), type (digital/cash/bank), gateway (paystack/flutterwave), date range.',
      },
      {
        method: 'GET',
        path: '/api/v1/giving/transactions/:transactionId',
        title: 'Get transaction details',
        curl: `curl -X GET https://api.churchos.com/api/v1/giving/transactions/txn_001 \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "id": "txn_001",
    "member": { "id": "mem_001234", "firstName": "Chioma", "lastName": "Okafor" },
    "category": { "id": "cat_tithe", "name": "Tithe" },
    "amount": 50000,
    "type": "digital",
    "gateway": "paystack",
    "gatewayReference": "paystack_ref_001",
    "status": "success",
    "receiptNumber": "2026/TIT/0001",
    "createdAt": "2026-07-20T10:00:00+01:00"
  }
}`,
        note: 'Returns the full transaction detail including gateway reference and receipt number.',
      },
    ],
  },
  {
    id: '37',
    category: 'Giving',
    title: 'PDF Receipt Download',
    description:
      'Download a PDF receipt for any successful giving transaction. Receipts are auto-generated with a sequential receipt number.',
    prerequisites: 'Transaction must have status "success" in the same church.',
    businessRule:
      'Receipt numbers follow the format: {YEAR}/{CATEGORY_PREFIX}/{SEQUENTIAL} (e.g., 2026/TIT/0001). PDF is generated server-side using PDFKit.',
    steps: [
      {
        method: 'GET',
        path: '/api/v1/giving/transactions/:transactionId/receipt',
        title: 'Download receipt',
        curl: `curl -X GET https://api.churchos.com/api/v1/giving/transactions/txn_001/receipt \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `Binary PDF response with:
Content-Type: application/pdf
Content-Disposition: attachment; filename="receipt-2026-TIT-0001.pdf"

Includes: Church name, member name, receipt number, date, category, amount (in words + figures), payment method, and authorized signature.`,
        note: 'The response is a binary PDF. Set response type to arraybuffer or blob in the client. Returns 400 if transaction is not successful.',
      },
    ],
  },

  // ── Events (cont.) ───────────────────────────────────────────
  {
    id: '38',
    category: 'Events',
    title: 'Paid Event Ticket Tiers',
    description:
      'Create and manage multi-tier ticket pricing for paid events. Supports early bird, regular, and VIP tiers with quantity limits.',
    prerequisites:
      'Event must exist and have type "paid". Church_admin or branch_pastor role required.',
    businessRule:
      'Ticket tiers are created after the event. Capacity is enforced per tier. Total registrations cannot exceed event capacity across all tiers.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/events/:eventId/tiers',
        title: 'Create ticket tier',
        curl: `curl -X POST https://api.churchos.com/api/v1/events/evt_001/tiers \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Early Bird",
    "price": 5000,
    "quantity": 100,
    "description": "Early bird registration - limited seats"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "tier_001",
    "eventId": "evt_001",
    "name": "Early Bird",
    "price": 5000,
    "quantity": 100,
    "sold": 0,
    "status": "active"
  }
}`,
        note: 'Price is in Naira (NGN). Multiple tiers can be created per event (e.g., Early Bird, Regular, VIP).',
      },
      {
        method: 'GET',
        path: '/api/v1/events/:eventId/tiers',
        title: 'List ticket tiers',
        curl: `curl -X GET https://api.churchos.com/api/v1/events/evt_001/tiers \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    { "id": "tier_001", "name": "Early Bird", "price": 5000, "quantity": 100, "sold": 45, "status": "active" },
    { "id": "tier_002", "name": "Regular", "price": 10000, "quantity": 200, "sold": 0, "status": "active" },
    { "id": "tier_003", "name": "VIP", "price": 25000, "quantity": 50, "sold": 10, "status": "active" }
  ]
}`,
        note: 'Tiers are returned sorted by price ascending.',
      },
    ],
  },
  {
    id: '39',
    category: 'Events',
    title: 'Event Registration & Ticket Purchase',
    description:
      'Register members for events. For free events, registration is instant. For paid events, payment is required before registration is confirmed.',
    prerequisites: 'Event must exist and registration must be open.',
    businessRule:
      'Free events confirm registration immediately. Paid events require payment confirmation via webhook before ticket is issued. Capacity and duplicate checks apply.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/events/:eventId/register',
        title: 'Register member for event',
        curl: `curl -X POST https://api.churchos.com/api/v1/events/evt_001/register \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "member_id": "mem_001234",
    "tier_id": "tier_001"
  }'`,
        response: `{
  "success": true,
  "data": {
    "registrationId": "reg_001",
    "eventId": "evt_001",
    "memberId": "mem_001234",
    "tierId": "tier_001",
    "status": "pending_payment",
    "amountDue": 5000,
    "paymentUrl": "https://api.churchos.com/api/v1/giving/initialize?reference=ref_001"
  }
}`,
        note: 'For free events (no tier_id), registration is immediately confirmed. For paid events, the member must complete payment via the returned paymentUrl.',
      },
      {
        method: 'DELETE',
        path: '/api/v1/events/:eventId/register/:memberId',
        title: 'Cancel registration',
        curl: `curl -X DELETE https://api.churchos.com/api/v1/events/evt_001/register/mem_001234 \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "message": "Registration cancelled."
}`,
        note: 'Cancellation frees up the ticket slot. Refund policy is handled externally.',
      },
    ],
  },
  {
    id: '40',
    category: 'Events',
    title: 'Event Ticket Validation',
    description:
      'Validate tickets at the event entrance. Each ticket has a unique code that can be scanned or entered manually.',
    prerequisites:
      'Event must be ongoing or upcoming. Ticket must exist and be confirmed (payment completed).',
    businessRule:
      'Tickets can only be validated once. Validation records the timestamp and validator identity for audit.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/events/:eventId/tickets/validate',
        title: 'Validate ticket',
        curl: `curl -X POST https://api.churchos.com/api/v1/events/evt_001/tickets/validate \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "ticket_code": "TKT-001-ABC123"
  }'`,
        response: `{
  "success": true,
  "data": {
    "ticketId": "tkt_001",
    "tierName": "Early Bird",
    "registrantName": "Chioma Okafor",
    "validatedAt": "2026-07-25T09:00:00+01:00",
    "validatedBy": "a1b2c3d4-..."
  }
}`,
        note: 'Returns 409 if ticket was already validated. Returns 404 if ticket code is invalid.',
      },
    ],
  },
  {
    id: '41',
    category: 'Events',
    title: 'Event Payment Webhook',
    description:
      'Handle Paystack payment confirmation for paid event registrations. Called automatically by Paystack after successful payment.',
    prerequisites:
      'Paystack must be configured as the payment gateway. The event registration must have a pending payment.',
    businessRule:
      'Webhook verifies HMAC-SHA512 signature (x-paystack-signature). Idempotent for terminal states: already-confirmed registrations are skipped.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/events/:eventId/webhook/paystack',
        title: 'Event payment webhook',
        curl: `curl -X POST https://api.churchos.com/api/v1/events/evt_001/webhook/paystack \\
  -H "Content-Type: application/json" \\
  -H "x-paystack-signature: sha512=hmac_signature" \\
  -d '{
    "event": "charge.success",
    "data": {
      "reference": "paystack_ref_001",
      "amount": 500000,
      "status": "success",
      "customer": { "email": "chioma@example.com" }
    }
  }'`,
        response: `{
  "success": true,
  "message": "Webhook processed."
}`,
        note: 'On success, the registration status changes to "confirmed" and a ticket with unique code is generated. Paystack amounts are in kobo (500000 = NGN 5,000).',
      },
    ],
  },

  // ── Sermons (cont.) ──────────────────────────────────────────
  {
    id: '42',
    category: 'Sermons',
    title: 'Sermon Archive & Search',
    description:
      'Create, search, and manage sermon records. Supports filtering by speaker, series, tags, and date ranges for easy discovery.',
    prerequisites: 'Church_admin or branch_pastor role required for creating/updating sermons.',
    businessRule:
      'Sermons are scoped by church_id. Audio URLs are set after upload to Supabase Storage via the MediaService.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/sermons',
        title: 'Create sermon record',
        curl: `curl -X POST https://api.churchos.com/api/v1/sermons \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "title": "Walking in Dominion",
    "speaker": "Pastor John Adeyemi",
    "series": "Kingdom Principles",
    "date_preached": "2026-07-20",
    "tags": ["faith", "dominion", "power"],
    "description": "A powerful message on walking in God\'s authority."
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "serm_001",
    "title": "Walking in Dominion",
    "speaker": "Pastor John Adeyemi",
    "series": "Kingdom Principles",
    "datePreached": "2026-07-20",
    "tags": ["faith", "dominion", "power"]
  }
}`,
        note: 'Audio URL is set separately after upload via PATCH /api/v1/sermons/:sermonId.',
      },
      {
        method: 'GET',
        path: '/api/v1/sermons',
        title: 'List and search sermons',
        curl: `curl -X GET "https://api.churchos.com/api/v1/sermons?speaker=Pastor+John&series=Kingdom+Principles&tag=faith&start_date=2026-01-01&end_date=2026-07-31&page=1&limit=20" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    { "id": "serm_001", "title": "Walking in Dominion", "speaker": "Pastor John Adeyemi", "datePreached": "2026-07-20", "audioUrl": null }
  ],
  "meta": { "page": 1, "limit": 20, "total": 15, "totalPages": 1 }
}`,
        note: 'Search supports free-text on title/description, exact match on speaker/series/tags.',
      },
      {
        method: 'GET',
        path: '/api/v1/sermons/:sermonId',
        title: 'Get single sermon',
        curl: `curl -X GET https://api.churchos.com/api/v1/sermons/serm_001 \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "id": "serm_001",
    "title": "Walking in Dominion",
    "speaker": "Pastor John Adeyemi",
    "series": "Kingdom Principles",
    "datePreached": "2026-07-20",
    "tags": ["faith", "dominion", "power"],
    "description": "A powerful message on walking in God\'s authority.",
    "audioUrl": "https://storage.churchos.com/sermons/serm_001.mp3",
    "createdAt": "2026-07-20T12:00:00+01:00"
  }
}`,
        note: 'Returns full sermon details including audio URL if uploaded.',
      },
      {
        method: 'PATCH',
        path: '/api/v1/sermons/:sermonId',
        title: 'Update sermon',
        curl: `curl -X PATCH https://api.churchos.com/api/v1/sermons/serm_001 \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "audioUrl": "https://storage.churchos.com/sermons/serm_001.mp3",
    "tags": ["faith", "dominion", "power", "audio"]
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "serm_001",
    "audioUrl": "https://storage.churchos.com/sermons/serm_001.mp3",
    "updatedAt": "2026-07-21T15:00:00+01:00"
  }
}`,
        note: 'Only provided fields are updated. Audio URL is typically set via PATCH after a successful upload.',
      },
      {
        method: 'DELETE',
        path: '/api/v1/sermons/:sermonId',
        title: 'Delete sermon',
        curl: `curl -X DELETE https://api.churchos.com/api/v1/sermons/serm_001 \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "message": "Sermon deleted."
}`,
        note: 'Permanently deletes the sermon record. Audio file in storage must be deleted separately via MediaService.',
      },
    ],
  },

  // ── WhatsApp (cont.) ─────────────────────────────────────────
  {
    id: '43',
    category: 'WhatsApp',
    title: 'WhatsApp Template Messaging',
    description:
      'Send pre-approved WhatsApp template messages to members. Templates must be created and approved by WhatsApp before use.',
    prerequisites:
      'Template must have external_status "published" and channel "whatsapp". 360dialog API key must be configured.',
    businessRule:
      'Templates use variable interpolation with {{1}}, {{2}} placeholders. Only published templates can be sent. Rate limit: 1000 messages/minute.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/whatsapp/send-template',
        title: 'Send template message',
        curl: `curl -X POST https://api.churchos.com/api/v1/whatsapp/send-template \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "phone": "+2348034567890",
    "template_id": "tpl_welcome_001",
    "parameters": ["Chioma", "RCCG Victory Chapel", "Sunday 8AM"]
  }'`,
        response: `{
  "success": true,
  "data": {
    "messageId": "msg_001",
    "channel": "whatsapp",
    "to": "+2348034567890",
    "status": "queued"
  }
}`,
        note: 'Parameters are substituted into the template in order. The message is queued in BullMQ for async delivery via 360dialog Cloud API.',
      },
    ],
  },
  {
    id: '44',
    category: 'WhatsApp',
    title: 'WhatsApp Message History',
    description:
      'View sent and received WhatsApp messages with delivery status tracking. Supports filtering by phone number, direction, and date range.',
    prerequisites: 'WhatsApp channel must be configured with 360dialog.',
    businessRule:
      'Messages are logged to the Message model with direction (inbound/outbound) and channel status. Webhook updates status asynchronously.',
    steps: [
      {
        method: 'GET',
        path: '/api/v1/whatsapp/messages',
        title: 'List WhatsApp messages',
        curl: `curl -X GET "https://api.churchos.com/api/v1/whatsapp/messages?phone=%2B2348034567890&direction=outbound&page=1&limit=20" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    { "id": "msg_001", "to": "+2348034567890", "direction": "outbound", "content": "Hello Chioma! Welcome...", "status": "delivered", "sentAt": "2026-07-21T10:00:00+01:00" }
  ],
  "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}`,
        note: 'Status values: queued, sent, delivered, read, failed. Direction: inbound (from member), outbound (to member).',
      },
    ],
  },

  // ── Templates ────────────────────────────────────────────────
  {
    id: '45',
    category: 'Templates',
    title: 'Create & List Message Templates',
    description:
      'Create and manage message templates for WhatsApp, SMS, and Email channels. Templates support variable placeholders for personalization.',
    prerequisites: 'Church_admin or branch_pastor role required.',
    businessRule:
      'Templates are scoped by church_id. Each template has a channel (whatsapp, sms, email), category (transactional, promotional, alert), and optional external_id for WhatsApp approval tracking.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/templates',
        title: 'Create template',
        curl: `curl -X POST https://api.churchos.com/api/v1/templates \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Welcome Message",
    "channel": "whatsapp",
    "category": "transactional",
    "content": "Welcome {{1}} to {{2}}! We are thrilled to have you. Service starts at {{3}}.",
    "variables": ["member_name", "church_name", "service_time"]
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "tpl_welcome_001",
    "name": "Welcome Message",
    "channel": "whatsapp",
    "category": "transactional",
    "content": "Welcome {{1}} to {{2}}!...",
    "status": "draft"
  }
}`,
        note: 'WhatsApp templates require additional approval via 360dialog. Status changes: draft → submitted → published → rejected.',
      },
      {
        method: 'GET',
        path: '/api/v1/templates',
        title: 'List templates',
        curl: `curl -X GET "https://api.churchos.com/api/v1/templates?channel=whatsapp&status=published&page=1&limit=20" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    { "id": "tpl_welcome_001", "name": "Welcome Message", "channel": "whatsapp", "category": "transactional", "status": "published" }
  ],
  "meta": { "page": 1, "limit": 20, "total": 5, "totalPages": 1 }
}`,
        note: 'Filters: channel (whatsapp, sms, email), category, status (draft, published, archived), search by name.',
      },
    ],
  },
  {
    id: '46',
    category: 'Templates',
    title: 'Template Update & Status Management',
    description:
      'Update template content, manage approval status for WhatsApp templates, and archive unused templates.',
    prerequisites: 'Template must exist and belong to the church.',
    businessRule:
      'WhatsApp template content cannot be edited after submission: a new version must be created. SMS and Email templates can be freely updated.',
    steps: [
      {
        method: 'PATCH',
        path: '/api/v1/templates/:templateId',
        title: 'Update template',
        curl: `curl -X PATCH https://api.churchos.com/api/v1/templates/tpl_welcome_001 \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "content": "Welcome {{1}} to {{2}}! Join us every {{3}} at {{4}}.",
    "variables": ["member_name", "church_name", "service_day", "service_time"]
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "tpl_welcome_001",
    "name": "Welcome Message",
    "content": "Welcome {{1}} to {{2}}! Join us every {{3}} at {{4}}.",
    "variables": ["member_name", "church_name", "service_day", "service_time"],
    "status": "draft",
    "updatedAt": "2026-07-21T16:00:00+01:00"
  }
}`,
        note: 'WhatsApp templates may require re-submission for approval if content changes. SMS/Email updates take immediate effect.',
      },
    ],
  },

  // ── Broadcasts ───────────────────────────────────────────────
  {
    id: '47',
    category: 'Broadcasts',
    title: 'Create & Send Broadcast Campaign',
    description:
      'Create and send bulk message campaigns to targeted audience segments with channel selection (WhatsApp, SMS, or Email).',
    prerequisites:
      'At least one template must exist for the selected channel. Church_admin or branch_pastor role required.',
    businessRule:
      'Audience is filtered by member status, branch, gender, and free-text search. Messages are enqueued to channel-specific BullMQ queues for async delivery.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/broadcasts',
        title: 'Create broadcast',
        curl: `curl -X POST https://api.churchos.com/api/v1/broadcasts \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "title": "Sunday Service Reminder",
    "channel": "whatsapp",
    "template_id": "tpl_reminder_001",
    "parameters": ["Sunday", "08:00 AM"],
    "audience_filter": {
      "status": "active",
      "branch_ids": ["br_001", "br_002"],
      "gender": "all"
    },
    "scheduled_at": "2026-07-24T06:00:00+01:00"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "bc_001",
    "title": "Sunday Service Reminder",
    "channel": "whatsapp",
    "status": "scheduled",
    "totalRecipients": 450,
    "scheduledAt": "2026-07-24T06:00:00+01:00"
  }
}`,
        note: 'If scheduled_at is omitted, the broadcast is sent immediately. TotalRecipients is estimated based on audience filter.',
      },
      {
        method: 'GET',
        path: '/api/v1/broadcasts',
        title: 'List broadcasts',
        curl: `curl -X GET "https://api.churchos.com/api/v1/broadcasts?status=scheduled&page=1&limit=20" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    { "id": "bc_001", "title": "Sunday Service Reminder", "channel": "whatsapp", "status": "scheduled", "totalRecipients": 450, "sentCount": 0, "failedCount": 0, "scheduledAt": "2026-07-24T06:00:00+01:00" }
  ],
  "meta": { "page": 1, "limit": 20, "total": 3, "totalPages": 1 }
}`,
        note: 'Status values: draft, scheduled, sending, completed, cancelled, failed.',
      },
    ],
  },
  {
    id: '48',
    category: 'Broadcasts',
    title: 'Monitor & Cancel Broadcast',
    description:
      'Track broadcast progress with real-time delivery stats and cancel scheduled broadcasts before they begin sending.',
    prerequisites: 'Broadcast must exist and belong to the church.',
    businessRule:
      'Only broadcasts with status "scheduled" or "draft" can be cancelled. Already-sending broadcasts cannot be interrupted.',
    steps: [
      {
        method: 'GET',
        path: '/api/v1/broadcasts/:broadcastId',
        title: 'Get broadcast details',
        curl: `curl -X GET https://api.churchos.com/api/v1/broadcasts/bc_001 \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "id": "bc_001",
    "title": "Sunday Service Reminder",
    "channel": "whatsapp",
    "status": "sending",
    "totalRecipients": 450,
    "sentCount": 230,
    "deliveredCount": 200,
    "readCount": 150,
    "failedCount": 5,
    "progressPercent": 51,
    "scheduledAt": "2026-07-24T06:00:00+01:00",
    "sentAt": "2026-07-24T06:00:05+01:00"
  }
}`,
        note: 'Delivery stats are updated asynchronously via webhook callbacks from 360dialog/Termii/Resend.',
      },
      {
        method: 'PATCH',
        path: '/api/v1/broadcasts/:broadcastId/cancel',
        title: 'Cancel broadcast',
        curl: `curl -X PATCH https://api.churchos.com/api/v1/broadcasts/bc_001/cancel \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "message": "Broadcast cancelled."
}`,
        note: 'Returns 400 if broadcast has already started sending or has already completed.',
      },
    ],
  },

  // ── Pastoral (cont.) ─────────────────────────────────────────
  {
    id: '49',
    category: 'Pastoral',
    title: 'Life Event Tracking',
    description:
      'Record and manage significant life events for members including birthdays, weddings, baptisms, dedications, and anniversaries.',
    prerequisites:
      'Member must exist in the church. Church_admin, branch_pastor, or pastoral team role required.',
    businessRule:
      'Life events are used for automated greeting campaigns and pastoral follow-up. Events are linked to members and can trigger notifications.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/pastoral/life-events',
        title: 'Record life event',
        curl: `curl -X POST https://api.churchos.com/api/v1/pastoral/life-events \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "member_id": "mem_001234",
    "event_type": "birthday",
    "event_date": "1990-08-15",
    "description": "Member birthday"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "le_001",
    "memberId": "mem_001234",
    "memberName": "Chioma Okafor",
    "eventType": "birthday",
    "eventDate": "1990-08-15",
    "createdAt": "2026-07-21T16:00:00+01:00"
  }
}`,
        note: 'Event types: birthday, wedding, death, dedication, baptism, anniversary. Each member can have multiple events.',
      },
      {
        method: 'GET',
        path: '/api/v1/pastoral/life-events',
        title: 'List life events',
        curl: `curl -X GET "https://api.churchos.com/api/v1/pastoral/life-events?member_id=mem_001234&event_type=birthday&page=1&limit=20" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    { "id": "le_001", "memberName": "Chioma Okafor", "eventType": "birthday", "eventDate": "1990-08-15" }
  ],
  "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}`,
        note: 'Filters: member_id, event_type, date range.',
      },
    ],
  },
  {
    id: '50',
    category: 'Pastoral',
    title: 'Upcoming Life Events & Engagement Scores',
    description:
      'View upcoming life events for automated greetings and track member engagement and risk scores.',
    prerequisites:
      'Life events must be recorded. Scoring requires sufficient activity data (attendance, giving, events, communication).',
    businessRule:
      'Engagement score (0-100) weights: attendance 30%, giving 25%, events 20%, communication 15%, consistency 10%. Risk score flags members with declining participation.',
    steps: [
      {
        method: 'GET',
        path: '/api/v1/pastoral/life-events/upcoming',
        title: 'Upcoming life events',
        curl: `curl -X GET "https://api.churchos.com/api/v1/pastoral/life-events/upcoming?days_ahead=7" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    { "type": "birthday", "memberName": "Chioma Okafor", "date": "08-15", "daysUntil": 24 },
    { "type": "wedding", "memberName": "Emeka & Amara Nwosu", "date": "08-10", "daysUntil": 19 }
  ]
}`,
        note: 'Returns events occurring within the specified days_ahead window (default 30). Useful for automated greeting campaigns.',
      },
      {
        method: 'GET',
        path: '/api/v1/pastoral/scores',
        title: 'List engagement & risk scores',
        curl: `curl -X GET "https://api.churchos.com/api/v1/pastoral/scores?level=high&page=1&limit=20" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    { "memberId": "mem_001234", "memberName": "Chioma Okafor", "engagementScore": 78, "engagementLevel": "high", "riskScore": 12, "riskLevel": "low" }
  ],
  "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}`,
        note: 'Risk levels: low, medium, high, critical. Engagement levels: low, medium, high. Scores are recalculated nightly via BullMQ NightlyJobsProcessor.',
      },
    ],
  },
  {
    id: '51',
    category: 'Pastoral',
    title: 'Pastoral Notes & Confidentiality',
    description:
      'Create and manage encrypted pastoral notes with confidentiality-based access control. Supports standard, confidential, and restricted notes.',
    prerequisites: 'Member must exist. PASTORAL_ENCRYPTION_KEY must be configured.',
    businessRule:
      'Notes are AES-256-GCM encrypted at rest. Confidential notes require church_admin/branch_pastor. Restricted notes require dual-authorization for deletion. Standard notes are visible to all pastoral staff.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/pastoral/notes',
        title: 'Create pastoral note',
        curl: `curl -X POST https://api.churchos.com/api/v1/pastoral/notes \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "member_id": "mem_001234",
    "content": "Counseling session about family reconciliation. Member is open to follow-up.",
    "confidentiality": "standard",
    "tags": ["counseling", "family"]
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "pn_001",
    "memberId": "mem_001234",
    "confidentiality": "standard",
    "tags": ["counseling", "family"],
    "createdBy": "a1b2c3d4-...",
    "createdAt": "2026-07-21T17:00:00+01:00"
  }
}`,
        note: 'Confidentiality levels: standard (all pastoral staff), confidential (admin+pastor only), restricted (dual-auth deletion). Content is encrypted before storage.',
      },
    ],
  },

  // ── Admin (cont.) ────────────────────────────────────────────
  {
    id: '52',
    category: 'Admin',
    title: 'Admin Dashboard Overview',
    description:
      'Access the admin dashboard with aggregated metrics including members needing attention, engagement distribution, and rising stars.',
    prerequisites: 'Requires church_admin, senior_pastor, or branch_pastor role.',
    businessRule:
      'Dashboard data is pre-computed from aggregated queries across multiple tables. Metrics are updated nightly but can be manually refreshed.',
    steps: [
      {
        method: 'GET',
        path: '/api/v1/admin/dashboard',
        title: 'Get dashboard overview',
        curl: `curl -X GET https://api.churchos.com/api/v1/admin/dashboard \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "membersNeedingAttention": 12,
    "engagementDistribution": { "high": 245, "medium": 180, "low": 45 },
    "risingStars": [
      { "memberId": "mem_005", "name": "Amara Uche", "engagementTrend": "+15%", "reason": "Consistent attendance for 8 weeks" }
    ],
    "flaggedMembers": 3,
    "recentLifeEvents": 8
  }
}`,
        note: 'Members needing attention are those with high risk scores or declining engagement. Rising stars show 20%+ engagement increase over 30 days.',
      },
    ],
  },
  {
    id: '53',
    category: 'Admin',
    title: 'Manual Score Recalculation',
    description:
      'Trigger manual recalculation of engagement and risk scores for a specific member or the entire church.',
    prerequisites: 'Requires church_admin or senior_pastor role.',
    businessRule:
      'Recalculation is processed asynchronously via BullMQ. Large churches (>5000 members) may take several minutes. Rate limit: 1 request per 5 minutes.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/admin/scores/recalculate',
        title: 'Recalculate scores',
        curl: `curl -X POST https://api.churchos.com/api/v1/admin/scores/recalculate \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "member_id": "mem_001234"
  }'`,
        response: `{
  "success": true,
  "message": "Score recalculation queued.",
  "data": {
    "queueId": "job_001",
    "estimatedDuration": "2 seconds"
  }
}`,
        note: 'If member_id is omitted, all members in the church are recalculated. The job runs in the nightly-jobs BullMQ queue.',
      },
    ],
  },

  // ── Assets (cont.) ───────────────────────────────────────────
  {
    id: '54',
    category: 'Assets',
    title: 'Asset Category Management',
    description:
      'Create and manage asset categories for organizing church inventory (furniture, electronics, vehicles, musical instruments, etc.).',
    prerequisites: 'Requires church_admin or branch_pastor role.',
    businessRule:
      'Category names must be unique within a church. Categories can be soft-deleted (deactivated) if no assets are assigned.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/assets/categories',
        title: 'Create asset category',
        curl: `curl -X POST https://api.churchos.com/api/v1/assets/categories \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Musical Instruments",
    "description": "Keyboards, drums, guitars, and audio equipment"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "cat_asset_001",
    "name": "Musical Instruments",
    "description": "Keyboards, drums, guitars, and audio equipment",
    "isActive": true
  }
}`,
        note: 'Default categories include: Furniture, Electronics, Vehicles, Musical Instruments, Kitchen, Office Equipment, IT Equipment, Other.',
      },
      {
        method: 'GET',
        path: '/api/v1/assets/categories',
        title: 'List asset categories',
        curl: `curl -X GET https://api.churchos.com/api/v1/assets/categories?is_active=true \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    { "id": "cat_asset_001", "name": "Musical Instruments", "assetCount": 12 },
    { "id": "cat_asset_002", "name": "Furniture", "assetCount": 45 }
  ]
}`,
        note: 'Each category includes a count of active assets assigned to it.',
      },
    ],
  },
  {
    id: '55',
    category: 'Assets',
    title: 'Asset Registration & Lifecycle',
    description:
      'Register church assets with detailed information including purchase details, location, custodian, and condition tracking.',
    prerequisites: 'Asset category must exist. Church_admin or branch_pastor role required.',
    businessRule:
      'Asset tags are unique per church (format: CHURCHOS-XXX-001). Condition tracking: new, good, fair, poor, damaged. Status: active, maintenance, retired, lost.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/assets',
        title: 'Register asset',
        curl: `curl -X POST https://api.churchos.com/api/v1/assets \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Yamaha Keyboard P-125",
    "category_id": "cat_asset_001",
    "serial_number": "YKP125-2024-001",
    "brand": "Yamaha",
    "model": "P-125",
    "purchase_date": "2024-03-15",
    "purchase_cost": 450000,
    "location": "Main Sanctuary",
    "custodian_id": "mem_001234",
    "department_id": "dept_001",
    "condition": "good"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "ast_001",
    "assetTag": "CHURCHOS-001-001",
    "name": "Yamaha Keyboard P-125",
    "category": "Musical Instruments",
    "condition": "good",
    "status": "active",
    "purchaseCost": 450000
  }
}`,
        note: 'The asset tag is auto-generated from a church-specific prefix and sequential number. Purchase cost is in Naira.',
      },
      {
        method: 'GET',
        path: '/api/v1/assets',
        title: 'List and search assets',
        curl: `curl -X GET "https://api.churchos.com/api/v1/assets?search=Yamaha&category=cat_asset_001&status=active&page=1&limit=20" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    { "id": "ast_001", "assetTag": "CHURCHOS-001-001", "name": "Yamaha Keyboard P-125", "condition": "good", "status": "active", "custodian": "Chioma Okafor" }
  ],
  "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}`,
        note: 'Search supports name, asset_tag, serial_number, and location fields.',
      },
    ],
  },
  {
    id: '56',
    category: 'Assets',
    title: 'Asset Maintenance & Depreciation',
    description:
      'Schedule and track asset maintenance tasks. Calculate depreciation using straight-line or reducing-balance methods.',
    prerequisites: 'Asset must be registered and active.',
    businessRule:
      'Maintenance statuses: scheduled, in_progress, completed, cancelled. Depreciation methods: straight-line (SL) or reducing-balance (RB). Yearly snapshots are stored.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/assets/:assetId/maintenance',
        title: 'Schedule maintenance',
        curl: `curl -X POST https://api.churchos.com/api/v1/assets/ast_001/maintenance \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "type": "routine",
    "description": "Annual keyboard tuning and cleaning",
    "scheduled_date": "2026-08-15",
    "estimated_cost": 25000,
    "assigned_to": "mem_005"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "mnt_001",
    "assetId": "ast_001",
    "type": "routine",
    "status": "scheduled",
    "scheduledDate": "2026-08-15",
    "estimatedCost": 25000
  }
}`,
        note: 'Maintenance types: routine, repair, inspection, upgrade, other.',
      },
      {
        method: 'POST',
        path: '/api/v1/assets/:assetId/depreciation',
        title: 'Record depreciation',
        curl: `curl -X POST https://api.churchos.com/api/v1/assets/ast_001/depreciation \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "method": "straight_line",
    "useful_life_years": 5,
    "salvage_value": 0
  }'`,
        response: `{
  "success": true,
  "data": {
    "assetId": "ast_001",
    "method": "straight_line",
    "annualDepreciation": 90000,
    "currentValue": 360000,
    "yearsRemaining": 4
  }
}`,
        note: 'Straight-line: (cost - salvage) / useful_life. Reducing-balance: book_value * (2 / useful_life). Depreciation starts from purchase date.',
      },
    ],
  },
  {
    id: '57',
    category: 'Assets',
    title: 'Asset Loan Management & QR Scanning',
    description:
      'Loan assets to members or external parties with return tracking. Generate QR codes for quick asset identification and scan logging.',
    prerequisites: 'Asset must be registered and in "active" status.',
    businessRule:
      'An asset on loan cannot be loaned again until returned. QR codes use format CHURCHOS:ASSET:<assetId>. Scan logs record timestamp, location, and scanner identity.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/assets/:assetId/loans',
        title: 'Loan asset to member',
        curl: `curl -X POST https://api.churchos.com/api/v1/assets/ast_001/loans \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "member_id": "mem_005",
    "expected_return_date": "2026-08-01",
    "purpose": "Conference usage",
    "notes": "Pickup from store room"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "loan_001",
    "assetId": "ast_001",
    "memberName": "Emeka Nwosu",
    "status": "active",
    "loanedAt": "2026-07-21T18:00:00+01:00",
    "expectedReturnDate": "2026-08-01"
  }
}`,
        note: 'Asset status changes to "on_loan" while the loan is active. Returns 409 if asset is already on loan.',
      },
      {
        method: 'PATCH',
        path: '/api/v1/assets/:assetId/loans/:loanId/return',
        title: 'Process asset return',
        curl: `curl -X PATCH https://api.churchos.com/api/v1/assets/ast_001/loans/loan_001/return \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "condition_on_return": "good",
    "notes": "Returned in good condition"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "loan_001",
    "status": "returned",
    "returnedAt": "2026-07-28T14:00:00+01:00",
    "conditionOnReturn": "good"
  }
}`,
        note: 'Asset status is restored to "active" after return. Damage is logged and may trigger a maintenance record.',
      },
      {
        method: 'POST',
        path: '/api/v1/assets/:assetId/qr',
        title: 'Generate QR code',
        curl: `curl -X POST https://api.churchos.com/api/v1/assets/ast_001/qr \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "qrData": "CHURCHOS:ASSET:ast_001",
    "qrImageUrl": "https://storage.churchos.com/qr/ast_001.png"
  }
}`,
        note: 'The QR code encodes the asset ID. Scan logs are recorded via POST /api/v1/assets/scan.',
      },
      {
        method: 'POST',
        path: '/api/v1/assets/scan',
        title: 'Log asset scan',
        curl: `curl -X POST https://api.churchos.com/api/v1/assets/scan \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "qr_data": "CHURCHOS:ASSET:ast_001",
    "location": "Main Sanctuary",
    "notes": "Routine scan during inventory"
  }'`,
        response: `{
  "success": true,
  "data": {
    "assetId": "ast_001",
    "assetName": "Yamaha Keyboard P-125",
    "scannedAt": "2026-07-21T19:00:00+01:00",
    "status": "active",
    "activeLoan": null
  }
}`,
        note: 'Scan returns the current asset status, condition, and any active loan info for immediate feedback.',
      },
    ],
  },

  // ── Forms ─────────────────────────────────────────────────────
  {
    id: '58',
    category: 'Forms',
    title: 'Form Builder & Publishing',
    description:
      'Create custom forms with field definitions (text, number, select, date, file, etc.), set visibility permissions, and publish for member submissions.',
    prerequisites: 'Church_admin or branch_pastor role required.',
    businessRule:
      'Forms can be public (anonymous submission via public_token) or private (authenticated members only). Forms support field validation, required fields, and file attachments.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/forms',
        title: 'Create form',
        curl: `curl -X POST https://api.churchos.com/api/v1/forms \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "title": "Volunteer Registration",
    "description": "Sign up to serve in various ministries",
    "is_public": false,
    "fields": [
      { "label": "Full Name", "type": "text", "required": true, "order": 1 },
      { "label": "Phone Number", "type": "text", "required": true, "order": 2 },
      { "label": "Ministry", "type": "select", "required": true, "options": ["Choir", "Ushering", "Media", "Children"], "order": 3 },
      { "label": "Available Days", "type": "multi_select", "options": ["Sunday", "Wednesday", "Friday", "Saturday"], "order": 4 }
    ]
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "form_001",
    "title": "Volunteer Registration",
    "isPublic": false,
    "status": "draft",
    "fieldCount": 4,
    "publicToken": null
  }
}`,
        note: 'Field types: text, number, email, phone, date, select, multi_select, checkbox, textarea, file. Forms start as "draft" until explicitly published.',
      },
      {
        method: 'GET',
        path: '/api/v1/forms',
        title: 'List forms',
        curl: `curl -X GET "https://api.churchos.com/api/v1/forms?status=published&page=1&limit=20" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    { "id": "form_001", "title": "Volunteer Registration", "status": "published", "submissionCount": 24, "isPublic": false }
  ],
  "meta": { "page": 1, "limit": 20, "total": 5, "totalPages": 1 }
}`,
        note: 'Filters: status (draft, published, archived), is_public.',
      },
    ],
  },
  {
    id: '59',
    category: 'Forms',
    title: 'Form Submissions & Attachments',
    description:
      'Submit form responses with field values and optional file attachments. Supports both authenticated and public anonymous submissions.',
    prerequisites:
      'Form must be published. Public forms require the public_token for anonymous access.',
    businessRule:
      'Submissions are validated against field definitions (required fields, type constraints). File attachments are uploaded via MediaService and linked to the submission.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/forms/:formId/submit',
        title: 'Submit form (authenticated)',
        curl: `curl -X POST https://api.churchos.com/api/v1/forms/form_001/submit \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "responses": [
      { "field_id": "field_001", "value": "Chioma Okafor" },
      { "field_id": "field_002", "value": "+2348034567890" },
      { "field_id": "field_003", "value": "Choir" },
      { "field_id": "field_004", "value": ["Sunday", "Wednesday"] }
    ]
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "sub_001",
    "formId": "form_001",
    "status": "pending",
    "submittedAt": "2026-07-21T20:00:00+01:00"
  }
}`,
        note: 'Submission status: pending, approved, rejected. File attachments must be uploaded separately via the file upload endpoint.',
      },
      {
        method: 'POST',
        path: '/api/v1/forms/public/:publicToken/submit',
        title: 'Submit form (public anonymous)',
        curl: `curl -X POST https://api.churchos.com/api/v1/forms/public/pub_token_123/submit \\
  -H "Content-Type: application/json" \\
  -d '{
    "responses": [
      { "field_id": "field_001", "value": "Anonymous Visitor" },
      { "field_id": "field_002", "value": "+2348098765432" }
    ]
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "sub_002",
    "formId": "form_001",
    "status": "pending",
    "submittedAt": "2026-07-21T20:30:00+01:00"
  }
}`,
        note: 'Public submissions do not require authentication. The public_token is generated when is_public is set to true on form creation.',
      },
    ],
  },
  {
    id: '60',
    category: 'Forms',
    title: 'Submission Approval Workflow',
    description:
      'Review, approve, or reject form submissions. Supports moderated workflows where submissions require admin approval before being finalized.',
    prerequisites:
      'Form must have submissions. Approver must have church_admin or branch_pastor role.',
    businessRule:
      'Approved submissions are finalized and cannot be modified. Rejected submissions include a rejection_reason. Submissions can be re-submitted after rejection.',
    steps: [
      {
        method: 'GET',
        path: '/api/v1/forms/:formId/submissions',
        title: 'List submissions',
        curl: `curl -X GET "https://api.churchos.com/api/v1/forms/form_001/submissions?status=pending&page=1&limit=20" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    { "id": "sub_001", "submittedBy": "Chioma Okafor", "status": "pending", "submittedAt": "2026-07-21T20:00:00+01:00" }
  ],
  "meta": { "page": 1, "limit": 20, "total": 12, "totalPages": 1 }
}`,
        note: 'Filters: status (pending, approved, rejected), submitted_by.',
      },
      {
        method: 'PATCH',
        path: '/api/v1/forms/:formId/submissions/:submissionId/approve',
        title: 'Approve submission',
        curl: `curl -X PATCH https://api.churchos.com/api/v1/forms/form_001/submissions/sub_001/approve \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "id": "sub_001",
    "status": "approved",
    "approvedBy": "Pastor Emeka",
    "approvedAt": "2026-07-22T09:00:00+01:00"
  }
}`,
        note: 'Once approved, the submission is locked. The associated data becomes visible in reports and member profiles.',
      },
      {
        method: 'PATCH',
        path: '/api/v1/forms/:formId/submissions/:submissionId/reject',
        title: 'Reject submission',
        curl: `curl -X PATCH https://api.churchos.com/api/v1/forms/form_001/submissions/sub_001/reject \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "rejection_reason": "Incomplete information. Please provide your phone number."
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "sub_001",
    "status": "rejected",
    "rejectionReason": "Incomplete information.",
    "rejectedBy": "Pastor Emeka",
    "rejectedAt": "2026-07-22T09:05:00+01:00"
  }
}`,
        note: 'Rejected submissions can be re-submitted by the original submitter with updated information.',
      },
    ],
  },

  // ── Analytics ─────────────────────────────────────────────────
  {
    id: '61',
    category: 'Analytics',
    title: 'Analytics Dashboard',
    description:
      'Access the unified analytics dashboard with a comprehensive overview of members, attendance, giving, risk scores, events, forms, and engagement.',
    prerequisites: 'Requires church_admin, senior_pastor, or branch_pastor role.',
    businessRule:
      'Dashboard data is computed from aggregated real-time queries across multiple tables. All metrics are scoped by church_id and date range.',
    steps: [
      {
        method: 'GET',
        path: '/api/v1/analytics/dashboard',
        title: 'Get dashboard overview',
        curl: `curl -X GET "https://api.churchos.com/api/v1/analytics/dashboard?start_date=2026-01-01&end_date=2026-07-31" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "members": { "total": 486, "active": 412, "newThisPeriod": 28, "growthRate": 6.1 },
    "attendance": { "totalCheckIns": 1240, "uniqueAttendees": 486, "avgPerService": 124 },
    "giving": { "totalRevenue": 2850000, "avgPerTransaction": 12500, "topCategory": "Tithe" },
    "riskSummary": { "high": 3, "medium": 12, "low": 471 },
    "events": { "upcoming": 5, "totalRegistrations": 320 },
    "forms": { "totalSubmissions": 156, "pendingApproval": 12 }
  }
}`,
        note: 'Date range filters apply to attendance, giving, and new members metrics. Other metrics reflect current state.',
      },
    ],
  },
  {
    id: '62',
    category: 'Analytics',
    title: 'Giving & Attendance Analytics',
    description:
      'Detailed analytics for giving (totals, trends, category breakdown, top donors) and attendance (check-ins, sources, branch breakdown, first-time vs returning).',
    prerequisites: 'Sufficient data must exist for meaningful analysis.',
    businessRule:
      'Giving analytics trend data can be grouped by daily, weekly, or monthly. Attendance analytics show source breakdown (QR, WhatsApp, manual) and branch-level stats.',
    steps: [
      {
        method: 'GET',
        path: '/api/v1/analytics/giving',
        title: 'Giving analytics',
        curl: `curl -X GET "https://api.churchos.com/api/v1/analytics/giving?start_date=2026-01-01&end_date=2026-07-31&group_by=month" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "totals": { "totalAmount": 2850000, "totalTransactions": 228, "avgPerTransaction": 12500 },
    "byCategory": [{ "category": "Tithe", "amount": 1850000, "percentage": 64.9 }],
    "byType": { "digital": 2100000, "cash": 500000, "bank": 250000 },
    "byBranch": [{ "branch": "Ikeja Main", "amount": 1750000 }],
    "topDonors": [{ "name": "Chioma Okafor", "total": 350000, "transactionCount": 12 }],
    "trends": [{ "period": "2026-07", "amount": 450000, "count": 35 }]
  }
}`,
        note: 'Group by supports: daily, weekly, monthly. Top donors returns the top 10 members by total giving.',
      },
      {
        method: 'GET',
        path: '/api/v1/analytics/attendance',
        title: 'Attendance analytics',
        curl: `curl -X GET "https://api.churchos.com/api/v1/analytics/attendance?start_date=2026-01-01&end_date=2026-07-31&group_by=month" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "totals": { "totalCheckIns": 1240, "uniqueMembers": 486, "avgPerService": 124 },
    "bySource": { "qr": 820, "whatsapp": 180, "manual": 240 },
    "byBranch": [{ "branch": "Ikeja Main", "checkIns": 650, "unique": 280 }],
    "byService": [{ "service": "Sunday 8AM", "avgAttendance": 150 }],
    "firstTimeVsReturning": { "firstTimers": 28, "returning": 458 },
    "trends": [{ "period": "2026-07", "checkIns": 1240, "unique": 486 }]
  }
}`,
        note: 'Source tracking helps measure effectiveness of different check-in methods (QR codes, WhatsApp, manual).',
      },
    ],
  },
  {
    id: '63',
    category: 'Analytics',
    title: 'Members, Events & Communication Analytics',
    description:
      'Member demographics and growth trends, event performance metrics, and communication channel delivery stats.',
    prerequisites: 'Sufficient data must exist for the queried period.',
    businessRule:
      'Member analytics include status breakdown, gender distribution, age group analysis. Event analytics include registration trends, revenue, and capacity utilization.',
    steps: [
      {
        method: 'GET',
        path: '/api/v1/analytics/members',
        title: 'Member analytics',
        curl: `curl -X GET "https://api.churchos.com/api/v1/analytics/members?start_date=2026-01-01&end_date=2026-07-31" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "byStatus": { "active": 412, "inactive": 48, "visitor": 26 },
    "byGender": { "male": 195, "female": 275, "unspecified": 16 },
    "byAgeGroup": { "0-17": 45, "18-25": 98, "26-40": 215, "41-60": 88, "60+": 40 },
    "monthlyGrowth": [{ "month": "2026-07", "newMembers": 28, "total": 486 }]
  }
}`,
        note: 'Growth rate is calculated as (new members - inactive) / total members for the period.',
      },
      {
        method: 'GET',
        path: '/api/v1/analytics/events',
        title: 'Event analytics',
        curl: `curl -X GET "https://api.churchos.com/api/v1/analytics/events?start_date=2026-01-01&end_date=2026-07-31" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "totalEvents": 15,
    "totalRegistrations": 320,
    "averageAttendance": 21,
    "totalRevenue": 850000,
    "byType": { "conference": 3, "seminar": 5, "retreat": 2, "fellowship": 5 },
    "averageCapacityUtilization": 72.5,
    "topEvents": [{ "name": "Annual Conference", "registrations": 120, "revenue": 500000 }]
  }
}`,
        note: 'Capacity utilization = total registrations / total capacity across all events.',
      },
      {
        method: 'GET',
        path: '/api/v1/analytics/communication',
        title: 'Communication analytics',
        curl: `curl -X GET "https://api.churchos.com/api/v1/analytics/communication?start_date=2026-01-01&end_date=2026-07-31" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "byChannel": {
      "whatsapp": { "sent": 12500, "delivered": 11875, "read": 8900, "failed": 180 },
      "sms": { "sent": 3200, "delivered": 3040, "failed": 160 },
      "email": { "sent": 4800, "delivered": 4560, "opened": 3200, "failed": 100 }
    },
    "broadcastSummary": { "total": 25, "completed": 22, "cancelled": 2, "failed": 1 }
  }
}`,
        note: 'Delivery rates vary by channel: WhatsApp typically 95%, SMS 95%, Email 90%. Failed messages are retried up to 3 times.',
      },
    ],
  },

  // ── Custom Fields ─────────────────────────────────────────────
  {
    id: '64',
    category: 'Custom Fields',
    title: 'Custom Field Management',
    description:
      'Create and manage custom fields for members and other entities. Extend member profiles with church-specific data fields.',
    prerequisites: 'Requires church_admin role.',
    businessRule:
      'Custom fields are scoped by church_id. Field types: text, number, date, select, multi_select, boolean. Custom fields appear in member detail responses and list filters.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/custom-fields',
        title: 'Create custom field',
        curl: `curl -X POST https://api.churchos.com/api/v1/custom-fields \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "entity_type": "member",
    "name": "Spiritual Gift",
    "field_type": "select",
    "options": ["Teaching", "Leadership", "Service", "Evangelism", "Pastoral"],
    "required": false,
    "order": 1
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "cf_001",
    "entityType": "member",
    "name": "Spiritual Gift",
    "fieldType": "select",
    "options": ["Teaching", "Leadership", "Service", "Evangelism", "Pastoral"],
    "required": false
  }
}`,
        note: 'Entity types: member, visitor, event. Custom fields are orderable and can be toggled between required/optional.',
      },
      {
        method: 'GET',
        path: '/api/v1/custom-fields',
        title: 'List custom fields',
        curl: `curl -X GET "https://api.churchos.com/api/v1/custom-fields?entity_type=member" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    { "id": "cf_001", "name": "Spiritual Gift", "fieldType": "select", "options": ["Teaching", "Leadership", "Service", "Evangelism", "Pastoral"], "required": false },
    { "id": "cf_002", "name": "Membership Certificate No.", "fieldType": "text", "required": false }
  ]
}`,
        note: 'Custom field values are returned alongside standard fields in member API responses.',
      },
    ],
  },

  // ── Visitors ──────────────────────────────────────────────────
  {
    id: '65',
    category: 'Visitors',
    title: 'Visitor Registration & Management',
    description:
      'Register and manage church visitors captured through the attendance visitor check-in flow or manual entry.',
    prerequisites: 'Visitor check-in requires an active service.',
    businessRule:
      'Visitors are stored as members with status "visitor". They can be converted to full members through the member update flow. Visitor data is scoped by church.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/visitors',
        title: 'Register visitor manually',
        curl: `curl -X POST https://api.churchos.com/api/v1/visitors \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "firstName": "Amara",
    "lastName": "Uche",
    "phone": "+2347066112233",
    "email": "amara@example.com",
    "invited_by_member_id": "mem_001234",
    "service_id": "srv_001"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "mem_visit_001",
    "firstName": "Amara",
    "lastName": "Uche",
    "phone": "+2347066112233",
    "status": "visitor",
    "visitedAt": "2026-07-21T20:00:00+01:00"
  }
}`,
        note: 'Visitors can optionally be linked to the member who invited them for follow-up attribution.',
      },
      {
        method: 'GET',
        path: '/api/v1/visitors',
        title: 'List visitors',
        curl: `curl -X GET "https://api.churchos.com/api/v1/visitors?status=visitor&start_date=2026-07-01&end_date=2026-07-31&page=1&limit=20" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    { "id": "mem_visit_001", "firstName": "Amara", "lastName": "Uche", "phone": "+2347066112233", "visitedAt": "2026-07-21", "invitedBy": "Chioma Okafor" }
  ],
  "meta": { "page": 1, "limit": 20, "total": 8, "totalPages": 1 }
}`,
        note: 'Visitors are members with status "visitor". Filter by status: visitor, converted, followed_up.',
      },
    ],
  },

  // ── Users (Staff) ─────────────────────────────────────────────
  {
    id: '66',
    category: 'Users',
    title: 'User Invitation & Listing',
    description:
      'Manage church users (staff accounts). Invite new users via email, list existing users with filters, and view user details.',
    prerequisites:
      'Requires church_admin or senior_pastor role. Supabase Auth admin API must be accessible.',
    businessRule:
      'Invitations use Supabase admin API to create users and send invite emails. Users are scoped by church_id. Listing supports search, filter by role/status, and sort.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/users/invite',
        title: 'Invite new user',
        curl: `curl -X POST https://api.churchos.com/api/v1/users/invite \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "email": "newstaff@example.com",
    "firstName": "Chidi",
    "lastName": "Okonkwo",
    "role": "branch_pastor",
    "branch_id": "br_002"
  }'`,
        response: `{
  "success": true,
  "data": {
    "userId": "usr_001",
    "email": "newstaff@example.com",
    "role": "branch_pastor",
    "status": "invited"
  },
  "message": "Invitation email sent to newstaff@example.com"
}`,
        note: 'The invited user receives an email to set their password. Status is "invited" until the user completes registration.',
      },
      {
        method: 'GET',
        path: '/api/v1/users',
        title: 'List users',
        curl: `curl -X GET "https://api.churchos.com/api/v1/users?search=Chidi&role=branch_pastor&status=active&page=1&limit=20&sort=lastName&order=asc" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    { "id": "usr_001", "email": "newstaff@example.com", "firstName": "Chidi", "lastName": "Okonkwo", "role": "branch_pastor", "branchId": "br_002", "status": "active", "lastLogin": "2026-07-20T10:00:00+01:00" }
  ],
  "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}`,
        note: 'Status values: active, invited, deactivated. Search is free-text on name and email.',
      },
      {
        method: 'GET',
        path: '/api/v1/users/:userId',
        title: 'Get user details',
        curl: `curl -X GET https://api.churchos.com/api/v1/users/usr_001 \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "id": "usr_001",
    "email": "newstaff@example.com",
    "firstName": "Chidi",
    "lastName": "Okonkwo",
    "phone": "+2348031112222",
    "role": "branch_pastor",
    "branch": { "id": "br_002", "name": "Surulere Chapel" },
    "status": "active",
    "lastLogin": "2026-07-20T10:00:00+01:00",
    "createdAt": "2026-07-15T08:00:00+01:00"
  }
}`,
        note: 'Returns the full user profile including Supabase user metadata.',
      },
    ],
  },
  {
    id: '67',
    category: 'Users',
    title: 'User Deactivation & Password Reset',
    description:
      'Deactivate user accounts, send password reset emails, and force sign-out for security management.',
    prerequisites: 'Requires church_admin or senior_pastor role. Cannot deactivate self.',
    businessRule:
      'Deactivation sets the user status to "deactivated" but retains the account record. Password reset sends a Supabase reset email. Force sign-out invalidates all active sessions.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/users/:userId/deactivate',
        title: 'Deactivate user',
        curl: `curl -X POST https://api.churchos.com/api/v1/users/usr_001/deactivate \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "message": "User account deactivated."
}`,
        note: 'Deactivated users cannot log in. Their data is retained for audit. Returns 400 if attempting to deactivate self.',
      },
      {
        method: 'POST',
        path: '/api/v1/users/:userId/reset-password',
        title: 'Send password reset',
        curl: `curl -X POST https://api.churchos.com/api/v1/users/usr_001/reset-password \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "message": "Password reset email sent."
}`,
        note: 'Uses Supabase admin API to send the password reset email. The user will receive a link to set a new password.',
      },
      {
        method: 'POST',
        path: '/api/v1/users/:userId/force-signout',
        title: 'Force sign-out',
        curl: `curl -X POST https://api.churchos.com/api/v1/users/usr_001/force-signout \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "message": "User signed out of all sessions."
}`,
        note: 'Uses Supabase admin API to revoke all active sessions for the user. The user will need to log in again.',
      },
    ],
  },

  // ── Notifications ─────────────────────────────────────────────
  {
    id: '68',
    category: 'Notifications',
    title: 'Notification Management',
    description:
      'View and manage in-app notifications for church members and staff. Supports read/unread tracking and bulk mark-as-read.',
    prerequisites: 'User must be authenticated.',
    businessRule:
      'Notifications are scoped by user (recipient). Unread count is a lightweight query for badge display. Notifications are auto-generated by system events (new member, giving received, etc.).',
    steps: [
      {
        method: 'GET',
        path: '/api/v1/notifications',
        title: 'List notifications',
        curl: `curl -X GET "https://api.churchos.com/api/v1/notifications?is_read=false&page=1&limit=20" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    { "id": "notif_001", "type": "new_member", "title": "New Member Registered", "body": "Chioma Okafor has been registered as a new member.", "isRead": false, "createdAt": "2026-07-21T20:00:00+01:00" }
  ],
  "meta": { "page": 1, "limit": 20, "total": 5, "totalPages": 1 }
}`,
        note: 'Notification types: new_member, giving_received, event_registration, pastoral_followup, broadcast_completed.',
      },
      {
        method: 'GET',
        path: '/api/v1/notifications/unread-count',
        title: 'Get unread count',
        curl: `curl -X GET https://api.churchos.com/api/v1/notifications/unread-count \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": { "unreadCount": 5 }
}`,
        note: 'Optimized query for badge display on mobile/web clients. Returns just the count for minimal payload.',
      },
      {
        method: 'PATCH',
        path: '/api/v1/notifications/:notificationId/read',
        title: 'Mark notification as read',
        curl: `curl -X PATCH https://api.churchos.com/api/v1/notifications/notif_001/read \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": { "id": "notif_001", "isRead": true }
}`,
        note: 'Single notification mark-as-read. Returns 404 if notification does not belong to the user.',
      },
      {
        method: 'PATCH',
        path: '/api/v1/notifications/read-all',
        title: 'Mark all as read',
        curl: `curl -X PATCH https://api.churchos.com/api/v1/notifications/read-all \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "message": "All notifications marked as read.",
  "data": { "updated": 5 }
}`,
        note: 'Bulk operation: marks all unread notifications for the authenticated user as read in a single query.',
      },
    ],
  },

  // ── Sync ──────────────────────────────────────────────────────
  {
    id: '69',
    category: 'Sync',
    title: 'Offline Data Synchronization',
    description:
      'Support offline mobile clients by providing push/pull sync with idempotency, conflict resolution, and cursor-based pagination.',
    prerequisites: 'Client must have a stable internet connection for the sync operation.',
    businessRule:
      'Idempotency: duplicate entity_id + action combinations are skipped. Conflict resolution: last-write-wins based on clientTimestamp. Pull uses cursor-based pagination for reliable offset handling.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/sync/push',
        title: 'Push offline changes',
        curl: `curl -X POST https://api.churchos.com/api/v1/sync/push \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "changes": [
      { "entity_type": "member", "entity_id": "mem_new_001", "action": "create", "data": { "firstName": "Offline", "lastName": "User" }, "clientTimestamp": "2026-07-22T10:00:00.000Z" }
    ]
  }'`,
        response: `{
  "success": true,
  "data": {
    "results": [
      { "entityId": "mem_new_001", "status": "applied", "serverTimestamp": "2026-07-22T10:00:05.000Z" }
    ]
  }
}`,
        note: 'Status values: applied, skipped (idempotent), conflict (server version wins).',
      },
      {
        method: 'GET',
        path: '/api/v1/sync/pull',
        title: 'Pull server changes',
        curl: `curl -X GET "https://api.churchos.com/api/v1/sync/pull?cursor=abc123&limit=100" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "changes": [
      { "entityType": "member", "entityId": "mem_001", "action": "update", "data": { "status": "active" }, "serverTimestamp": "2026-07-22T09:00:00.000Z" }
    ],
    "nextCursor": "def456",
    "hasMore": true
  }
}`,
        note: 'Cursor-based pagination ensures reliable pagination even when new data is being added.',
      },
      {
        method: 'POST',
        path: '/api/v1/sync/mark-synced',
        title: 'Acknowledge receipt',
        curl: `curl -X POST https://api.churchos.com/api/v1/sync/mark-synced \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "entityIds": ["mem_001", "mem_002"]
  }'`,
        response: `{
  "success": true,
  "data": { "marked": 2 }
}`,
        note: 'After the client has successfully applied pushed items, call this endpoint to acknowledge receipt. Prevents redundant sync operations.',
      },
    ],
  },

  // ── Reports ───────────────────────────────────────────────────
  {
    id: '70',
    category: 'Reports',
    title: 'Financial Reports',
    description:
      'Generate financial reports with revenue totals, category breakdowns, monthly trends, and branch-level analysis.',
    prerequisites: 'Requires church_admin, senior_pastor, or treasurer role.',
    businessRule:
      'All financial data is aggregated from the transactions table. Reports are scoped by church_id and can be filtered by date range, category, and branch.',
    steps: [
      {
        method: 'GET',
        path: '/api/v1/reports/financial',
        title: 'Financial report',
        curl: `curl -X GET "https://api.churchos.com/api/v1/reports/financial?start_date=2026-01-01&end_date=2026-07-31&group_by=month" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "summary": { "totalRevenue": 2850000, "totalTransactions": 228, "avgPerTransaction": 12500 },
    "byCategory": [{ "category": "Tithe", "amount": 1850000, "count": 120, "percentage": 64.9 }],
    "byType": { "digital": 2100000, "cash": 500000, "bank": 250000 },
    "byBranch": [{ "branch": "Ikeja Main", "amount": 1750000, "count": 130 }],
    "trends": [{ "period": "2026-07", "amount": 450000, "count": 35 }]
  }
}`,
        note: 'Group by supports: daily, weekly, monthly, quarterly, yearly. All amounts in Naira (NGN).',
      },
    ],
  },
  {
    id: '71',
    category: 'Reports',
    title: 'Attendance & Member Reports',
    description:
      'Generate attendance reports with service-level detail, trends, and member demographics reports including status and gender breakdowns.',
    prerequisites: 'Requires church_admin, senior_pastor, or branch_pastor role.',
    businessRule:
      'Attendance reports aggregate from the attendance table. Member reports include status distribution, gender breakdown, and monthly growth trends.',
    steps: [
      {
        method: 'GET',
        path: '/api/v1/reports/attendance',
        title: 'Attendance report',
        curl: `curl -X GET "https://api.churchos.com/api/v1/reports/attendance?start_date=2026-01-01&end_date=2026-07-31&group_by=month" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "totalCheckIns": 1240,
    "uniqueMembers": 486,
    "avgPerService": 124,
    "byService": [{ "service": "Sunday First Service", "checkIns": 450, "uniqueMembers": 380 }],
    "byBranch": [{ "branch": "Ikeja Main", "checkIns": 650, "uniqueMembers": 280 }],
    "trends": [{ "period": "2026-07", "checkIns": 1240, "avg": 124 }]
  }
}`,
        note: 'Group by supports: daily, weekly, monthly. Date range defaults to current year if not specified.',
      },
      {
        method: 'GET',
        path: '/api/v1/reports/members',
        title: 'Member report',
        curl: `curl -X GET "https://api.churchos.com/api/v1/reports/members?start_date=2026-01-01&end_date=2026-07-31" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "totalMembers": 486,
    "byStatus": { "active": 412, "inactive": 48, "visitor": 26 },
    "byGender": { "male": 195, "female": 275, "unspecified": 16 },
    "monthlyGrowth": [{ "month": "2026-07", "new": 28, "total": 486, "growthRate": 6.1 }]
  }
}`,
        note: 'Growth rate = (new - inactive) / total * 100. Only active members are counted in total for growth calculation.',
      },
      {
        method: 'POST',
        path: '/api/v1/reports/export',
        title: 'Export report as CSV',
        curl: `curl -X POST https://api.churchos.com/api/v1/reports/export \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "type": "members",
    "format": "csv",
    "start_date": "2026-01-01",
    "end_date": "2026-07-31",
    "fields": ["firstName", "lastName", "email", "phone", "role", "status"]
  }'`,
        response: `Binary CSV response with:
Content-Type: text/csv
Content-Disposition: attachment; filename="members-report-2026-07-31.csv"`,
        note: 'Export types: members, financial, attendance. Formats: csv, xlsx.',
      },
    ],
  },

  // ── Webhooks ──────────────────────────────────────────────────
  {
    id: '72',
    category: 'Webhooks',
    title: 'Webhook Subscription Management',
    description:
      'Create and manage outbound webhook subscriptions to receive real-time event notifications from the ChurchOS platform.',
    prerequisites: 'Requires church_admin or senior_pastor role.',
    businessRule:
      'Webhook payloads are signed with HMAC-SHA256. Delivery uses BullMQ with 3 retries and exponential backoff (5s, 25s, 125s). Supported events: member.created, member.updated, transaction.success, etc.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/webhooks',
        title: 'Create webhook subscription',
        curl: `curl -X POST https://api.churchos.com/api/v1/webhooks \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "url": "https://myapp.example.com/churchos-webhook",
    "events": ["member.created", "transaction.success", "attendance.recorded"],
    "description": "Sync members to external CRM",
    "secret": "my_webhook_secret_key"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "wh_001",
    "url": "https://myapp.example.com/churchos-webhook",
    "events": ["member.created", "transaction.success", "attendance.recorded"],
    "status": "active",
    "createdAt": "2026-07-22T08:00:00+01:00"
  }
}`,
        note: 'The secret is used for HMAC-SHA256 signature in the x-webhook-signature header. Store it securely on your end to verify payloads.',
      },
      {
        method: 'GET',
        path: '/api/v1/webhooks',
        title: 'List webhook subscriptions',
        curl: `curl -X GET "https://api.churchos.com/api/v1/webhooks?status=active&page=1&limit=20" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    { "id": "wh_001", "url": "https://myapp.example.com/churchos-webhook", "events": ["member.created", "transaction.success"], "status": "active", "lastDelivery": { "status": "success", "at": "2026-07-22T08:00:00+01:00" } }
  ],
  "meta": { "page": 1, "limit": 20, "total": 2, "totalPages": 1 }
}`,
        note: 'Status: active, paused, deactivated. Last delivery shows the most recent delivery attempt.',
      },
      {
        method: 'DELETE',
        path: '/api/v1/webhooks/:id',
        title: 'Deactivate webhook',
        curl: `curl -X DELETE https://api.churchos.com/api/v1/webhooks/wh_001 \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "message": "Webhook subscription deactivated."
}`,
        note: 'Deactivated webhooks are not deleted: they are soft-deactivated for audit trail.',
      },
    ],
  },
  {
    id: '73',
    category: 'Webhooks',
    title: 'Webhook Delivery Logs & Testing',
    description:
      'View delivery history for webhook subscriptions, including payload, response status, and retry attempts. Test webhook subscriptions with sample events.',
    prerequisites: 'Webhook subscription must exist and be active.',
    businessRule:
      'Delivery logs are retained for 30 days. Each delivery includes the full payload, response status code, response body (truncated), and duration. Failed deliveries include error details.',
    steps: [
      {
        method: 'GET',
        path: '/api/v1/webhooks/:id/deliveries',
        title: 'List delivery history',
        curl: `curl -X GET "https://api.churchos.com/api/v1/webhooks/wh_001/deliveries?status=failed&page=1&limit=20" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    { "id": "del_001", "event": "member.created", "url": "https://myapp.example.com/churchos-webhook", "status": "failed", "httpStatus": 500, "attempt": 2, "duration": 2500, "error": "Connection timed out", "sentAt": "2026-07-22T08:00:05+01:00" }
  ],
  "meta": { "page": 1, "limit": 20, "total": 3, "totalPages": 1 }
}`,
        note: 'Status: success, failed, retrying. Filter by status, event type, and date range.',
      },
      {
        method: 'POST',
        path: '/api/v1/webhooks/:id/test',
        title: 'Test webhook subscription',
        curl: `curl -X POST https://api.churchos.com/api/v1/webhooks/wh_001/test \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "deliveryId": "del_test_001",
    "event": "test",
    "url": "https://myapp.example.com/churchos-webhook",
    "status": "success",
    "httpStatus": 200,
    "duration": 340
  },
  "message": "Test webhook sent successfully."
}`,
        note: 'Sends a test payload to the webhook URL and returns the delivery result. Useful for verifying endpoint configuration before processing real events.',
      },
    ],
  },

  // ── Media ─────────────────────────────────────────────────────
  {
    id: '74',
    category: 'Media',
    title: 'File Upload & Optimization',
    description:
      'Upload images and files to Supabase Storage. Images are automatically optimized to WebP format with configurable quality and size limits.',
    prerequisites: 'Must be authenticated. Max file size is configurable (default 5MB).',
    businessRule:
      'Images are converted to WebP via sharp (quality 80, max 1200px width/height). Original files are stored as-is. A MediaAsset record is created for every upload with MIME type, size, and dimensions.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/media/upload/image',
        title: 'Upload and optimize image',
        curl: `curl -X POST https://api.churchos.com/api/v1/media/upload/image \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -F "image=@/home/user/photo.jpg"`,
        response: `{
  "success": true,
  "data": {
    "id": "asset_001",
    "url": "https://storage.churchos.com/media/asset_001.webp",
    "mimeType": "image/webp",
    "size": 84500,
    "width": 1200,
    "height": 900,
    "originalName": "photo.jpg",
    "folder": "uploads"
  }
}`,
        note: 'Supported input formats: JPEG, PNG, WebP, GIF. Output is always WebP. Set optional ?quality=90 or ?maxWidth=800 query params to override defaults.',
      },
      {
        method: 'POST',
        path: '/api/v1/media/upload',
        title: 'Upload file (no optimization)',
        curl: `curl -X POST https://api.churchos.com/api/v1/media/upload \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -F "file=@/home/user/document.pdf"`,
        response: `{
  "success": true,
  "data": {
    "id": "asset_002",
    "url": "https://storage.churchos.com/media/asset_002.pdf",
    "mimeType": "application/pdf",
    "size": 250000,
    "originalName": "document.pdf",
    "folder": "uploads"
  }
}`,
        note: 'Files are uploaded as-is without optimization. Suitable for PDFs, DOCX, audio files, and other binary formats.',
      },
    ],
  },
  {
    id: '75',
    category: 'Media',
    title: 'Media Library Management',
    description:
      'Browse, search, and manage uploaded media assets. Supports folder organization, permission settings, and asset deletion.',
    prerequisites: 'Media assets must exist. Deletion requires church_admin role.',
    businessRule:
      'Library supports filtering by folder, MIME type, and permission level. Deletion removes both the database record and the storage file. Permissions: public, church_only, admin_only.',
    steps: [
      {
        method: 'GET',
        path: '/api/v1/media/library',
        title: 'Browse media library',
        curl: `curl -X GET "https://api.churchos.com/api/v1/media/library?folder=sermons&mime_type=audio&page=1&limit=20" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    { "id": "asset_003", "url": "https://storage.churchos.com/media/asset_003.mp3", "mimeType": "audio/mpeg", "size": 5200000, "folder": "sermons", "permission": "church_only", "createdAt": "2026-07-20T12:00:00+01:00" }
  ],
  "meta": { "page": 1, "limit": 20, "total": 45, "totalPages": 3 }
}`,
        note: 'Filter by folder, MIME type (image, audio, video, application), and permission level.',
      },
      {
        method: 'GET',
        path: '/api/v1/media/library/folders',
        title: 'List unique folders',
        curl: `curl -X GET https://api.churchos.com/api/v1/media/library/folders \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": ["sermons", "avatars", "events", "forms", "uploads"]
}`,
        note: 'Returns unique folder names. Useful for building folder navigation UI.',
      },
      {
        method: 'GET',
        path: '/api/v1/media/library/:assetId',
        title: 'Get asset details',
        curl: `curl -X GET https://api.churchos.com/api/v1/media/library/asset_001 \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": {
    "id": "asset_001",
    "url": "https://storage.churchos.com/media/asset_001.webp",
    "mimeType": "image/webp",
    "size": 84500,
    "width": 1200,
    "height": 900,
    "originalName": "photo.jpg",
    "folder": "uploads",
    "permission": "church_only",
    "uploadedBy": { "id": "a1b2c3d4-...", "name": "Chioma Okafor" },
    "createdAt": "2026-07-20T08:30:00+01:00"
  }
}`,
        note: 'Returns full metadata including uploader info and timestamps.',
      },
      {
        method: 'PATCH',
        path: '/api/v1/media/library/:assetId/permissions',
        title: 'Update permissions',
        curl: `curl -X PATCH https://api.churchos.com/api/v1/media/library/asset_001/permissions \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "permission": "public"
  }'`,
        response: `{
  "success": true,
  "data": { "id": "asset_001", "permission": "public", "updatedAt": "2026-07-22T09:00:00+01:00" }
}`,
        note: 'Permissions: public (anyone with URL), church_only (authenticated church members), admin_only (admin roles only).',
      },
      {
        method: 'DELETE',
        path: '/api/v1/media/library/:assetId',
        title: 'Delete asset',
        curl: `curl -X DELETE https://api.churchos.com/api/v1/media/library/asset_001 \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "message": "Asset deleted from library."
}`,
        note: 'Removes both the database record and the physical file from Supabase Storage. Irreversible.',
      },
    ],
  },

  // ── Family ────────────────────────────────────────────────────
  {
    id: '76',
    category: 'Family',
    title: 'Family Group Management',
    description:
      'Create and manage family groups within the church. Associate members as family members with designated head-of-family and relationship tracking.',
    prerequisites: 'Members must exist in the church.',
    businessRule:
      'Each family has one head (the primary contact). Members can belong to one family at a time. Relationships: head, spouse, child, parent, sibling, other.',
    steps: [
      {
        method: 'POST',
        path: '/api/v1/families',
        title: 'Create family group',
        curl: `curl -X POST https://api.churchos.com/api/v1/families \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Okafor Family",
    "head_member_id": "mem_001234",
    "address": "42 Peace Avenue, Ikeja, Lagos"
  }'`,
        response: `{
  "success": true,
  "data": {
    "id": "fam_001",
    "name": "Okafor Family",
    "headMemberId": "mem_001234",
    "headName": "Chioma Okafor",
    "memberCount": 1,
    "address": "42 Peace Avenue, Ikeja, Lagos"
  }
}`,
        note: 'The head member is automatically added as a family member with relationship "head".',
      },
      {
        method: 'GET',
        path: '/api/v1/families',
        title: 'List families',
        curl: `curl -X GET "https://api.churchos.com/api/v1/families?search=Okafor&page=1&limit=20" \\
  -H "Authorization: Bearer eyJhbGciOi..."`,
        response: `{
  "success": true,
  "data": [
    { "id": "fam_001", "name": "Okafor Family", "headName": "Chioma Okafor", "memberCount": 4 }
  ],
  "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}`,
        note: 'Search by family name or head member name.',
      },
      {
        method: 'POST',
        path: '/api/v1/families/:familyId/members',
        title: 'Add member to family',
        curl: `curl -X POST https://api.churchos.com/api/v1/families/fam_001/members \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "member_id": "mem_002",
    "relationship": "spouse"
  }'`,
        response: `{
  "success": true,
  "data": {
    "familyId": "fam_001",
    "memberId": "mem_002",
    "memberName": "Emeka Okafor",
    "relationship": "spouse"
  }
}`,
        note: 'Relationships: head, spouse, child, parent, sibling, other. A member can only belong to one family at a time.',
      },
    ],
  },

  // ── Health ────────────────────────────────────────────────────
  {
    id: '77',
    category: 'Health',
    title: 'System Health Check',
    description:
      'Monitor system health including database connectivity, Redis availability, and all BullMQ queue statuses.',
    prerequisites: 'Public endpoint: no authentication required.',
    businessRule:
      'Health check returns live status of all infrastructure dependencies. Queue metrics include waiting, active, completed, and failed job counts. 5-second timeout per dependency.',
    steps: [
      {
        method: 'GET',
        path: '/api/v1/health',
        title: 'Get system health',
        curl: `curl -X GET https://api.churchos.com/api/v1/health`,
        response: `{
  "status": "ok",
  "timestamp": "2026-07-22T10:00:00.000Z",
  "uptime": 345600,
  "services": {
    "database": { "status": "healthy", "latencyMs": 3 },
    "redis": { "status": "healthy", "latencyMs": 2 },
    "queues": {
      "whatsapp-outbound": { "waiting": 5, "active": 2, "completed": 12500, "failed": 18 },
      "email-outbound": { "waiting": 0, "active": 0, "completed": 4800, "failed": 5 },
      "sms-outbound": { "waiting": 1, "active": 0, "completed": 3200, "failed": 8 },
      "recurring-giving": { "waiting": 0, "active": 0, "completed": 150, "failed": 2 },
      "nightly-jobs": { "waiting": 0, "active": 0, "completed": 30, "failed": 1 },
      "broadcast": { "waiting": 0, "active": 1, "completed": 25, "failed": 0 },
      "webhook-delivery": { "waiting": 3, "active": 0, "completed": 250, "failed": 5 },
      "dead-letter": { "waiting": 0, "active": 0, "completed": 0, "failed": 0 }
    }
  }
}`,
        note: 'If any service is unhealthy, overall status returns "degraded". Individual queue failures do not affect overall status: only the queue entry shows the issue.',
      },
    ],
  },
];

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderFlowStep(step: FlowStep): string {
  const methodBadge =
    step.method !== '-'
      ? `<span class="method-badge method-${step.method}">${step.method}</span>`
      : '';
  const pathHtml =
    step.path !== '-' ? `<code class="step-path">${escapeHtml(step.path)}</code>` : '';

  let curlSection = '';
  if (step.curl) {
    curlSection = `<div class="code-header">curl</div>
<pre class="code-block"><code>${escapeHtml(step.curl)}</code></pre>`;
  }

  let responseSection = '';
  if (step.response) {
    responseSection = `<div class="code-header">response</div>
<pre class="code-block"><code>${escapeHtml(step.response)}</code></pre>`;
  }

  const noteSection = step.note
    ? `<div class="callout"><strong>Note:</strong> ${escapeHtml(step.note)}</div>`
    : '';

  return `<div class="flow-step">
  <div class="step-heading">
    <span class="step-number">●</span>
    ${methodBadge}${pathHtml}
    <span class="step-title">${escapeHtml(step.title)}</span>
  </div>
  ${curlSection}
  ${responseSection}
  ${noteSection}
</div>`;
}

function renderFlow(flow: Flow): string {
  const stepsHtml = flow.steps.map(renderFlowStep).join('\n');
  const prereqHtml = flow.prerequisites
    ? `<div class="callout prereq"><strong>Prerequisites:</strong> ${escapeHtml(flow.prerequisites)}</div>`
    : '';
  const businessRuleHtml = flow.businessRule
    ? `<div class="callout"><strong>Business Rule:</strong> ${escapeHtml(flow.businessRule)}</div>`
    : '';

  return `<section id="flow-${flow.id}" class="flow-section">
  <div class="flow-header">
    <h2>${escapeHtml(flow.title)}</h2>
    <span class="step-badge">${flow.steps.length} steps</span>
  </div>
  <p class="flow-description">${escapeHtml(flow.description)}</p>
  ${prereqHtml}
  ${businessRuleHtml}
  <div class="steps-container">
    ${stepsHtml}
  </div>
</section>`;
}

export function renderGuidePage(baseUrl: string, swaggerUrl: string): string {
  const categories = new Map<string, Flow[]>();
  for (const flow of ALL_FLOWS) {
    if (!categories.has(flow.category)) {
      categories.set(flow.category, []);
    }
    categories.get(flow.category)!.push(flow);
  }

  const sidebarNav = Array.from(categories.entries())
    .map(([category, flows]) => {
      const links = flows
        .map(
          (f) =>
            `<a href="#flow-${f.id}">${escapeHtml(f.title)} <span class="count">${f.steps.length}</span></a>`,
        )
        .join('\n');
      return `<div class="nav-category">${escapeHtml(category)}</div>\n${links}`;
    })
    .join('\n');

  const contentHtml = Array.from(categories.entries())
    .map(([_category, flows]) => {
      return flows.map(renderFlow).join('\n');
    })
    .join('\n');

  const totalSteps = ALL_FLOWS.reduce((sum, f) => sum + f.steps.length, 0);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ChurchOS API: Developer Guide</title>
  <style>
    :root {
      --bg-primary: #0b1120;
      --bg-secondary: #0f172a;
      --bg-card: #1e293b;
      --bg-code: #0b1120;
      --border: #1e293b;
      --border-light: #334155;
      --text-primary: #f1f5f9;
      --text-secondary: #e2e8f0;
      --text-muted: #94a3b8;
      --text-dim: #475569;
      --accent: #6366f1;
      --accent-light: #818cf8;
      --accent-subtle: #a5b4fc;
      --accent-bg: rgba(99,102,241,0.12);
      --accent-bg-subtle: rgba(99,102,241,0.06);
      --scrollbar-track: #0b1120;
      --scrollbar-thumb: #334155;
      --sidebar-gradient: linear-gradient(135deg, #0f172a 0%, #1a1f2e 100%);
      --hero-gradient: linear-gradient(135deg, #0f172a 0%, #0b1120 100%);
      --success: #34d399;
      --success-bg: rgba(16,185,129,0.15);
      --warning: #fbbf24;
      --warning-bg: rgba(245,158,11,0.06);
      --warning-border: #f59e0b;
      --warning-text: #fde68a;
      --warning-text-strong: #fbbf24;
      --danger: #f87171;
      --danger-bg: rgba(239,68,68,0.15);
      --info: #60a5fa;
      --info-bg: rgba(59,130,246,0.15);
    }
    .light-mode {
      --bg-primary: #ffffff;
      --bg-secondary: #f8fafc;
      --bg-card: #ffffff;
      --bg-code: #f1f5f9;
      --border: #e2e8f0;
      --border-light: #cbd5e1;
      --text-primary: #0f172a;
      --text-secondary: #1e293b;
      --text-muted: #475569;
      --text-dim: #94a3b8;
      --accent: #4f46e5;
      --accent-light: #6366f1;
      --accent-subtle: #818cf8;
      --accent-bg: rgba(79,70,229,0.1);
      --accent-bg-subtle: rgba(79,70,229,0.05);
      --scrollbar-track: #f1f5f9;
      --scrollbar-thumb: #cbd5e1;
      --sidebar-gradient: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
      --hero-gradient: linear-gradient(135deg, #f1f5f9 0%, #f8fafc 100%);
      --success: #059669;
      --success-bg: rgba(5,150,105,0.1);
      --warning: #d97706;
      --warning-bg: rgba(217,119,6,0.06);
      --warning-border: #d97706;
      --warning-text: #92400e;
      --warning-text-strong: #92400e;
      --danger: #dc2626;
      --danger-bg: rgba(220,38,38,0.1);
      --info: #2563eb;
      --info-bg: rgba(37,99,235,0.1);
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: var(--bg-primary);
      color: var(--text-secondary);
      line-height: 1.8;
    }
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: var(--scrollbar-track); }
    ::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--border-light); }
    .sidebar {
      position: fixed; top: 0; left: 0; width: 280px; height: 100vh;
      background: var(--bg-secondary); border-right: 1px solid var(--border);
      overflow-y: auto; z-index: 100; padding-bottom: 2rem;
    }
    .sidebar-header {
      padding: 1.75rem 1.25rem;
      border-bottom: 1px solid var(--border);
      background: var(--sidebar-gradient);
    }
    .sidebar-header h1 {
      font-size: 1.125rem; font-weight: 700; color: var(--text-primary);
      letter-spacing: -0.02em;
    }
    .sidebar-header .subtitle {
      font-size: 0.75rem; color: var(--text-muted); margin-top: 0.375rem;
    }
    .sidebar-header .meta-info {
      margin-top: 0.75rem; font-size: 0.6875rem; color: var(--text-dim);
    }
    .sidebar-header .meta-info span { display: block; margin-top: 0.125rem; }
    .sidebar-header .meta-info strong { color: var(--text-muted); }
    .sidebar-header .top-row {
      display: flex; align-items: center; justify-content: space-between;
    }
    .sidebar-header .top-row .title-block { flex: 1; }
    .theme-toggle {
      background: transparent; border: 1px solid var(--border-light);
      color: var(--text-muted); cursor: pointer; font-size: 1rem;
      padding: 0.375rem; border-radius: 6px; line-height: 1;
      transition: all 0.15s ease; flex-shrink: 0;
    }
    .theme-toggle:hover { background: var(--accent-bg); color: var(--accent-light); }
    .sidebar-header .badge-row { margin-top: 0.625rem; display: flex; gap: 0.5rem; flex-wrap: wrap; }
    .sidebar-header .badge-row .badge {
      font-size: 0.625rem; font-weight: 600; padding: 0.1875rem 0.5rem;
      border-radius: 9999px; background: var(--accent-bg); color: var(--accent-light);
    }
    .sidebar-header .badge-row .badge.outline {
      background: transparent; border: 1px solid var(--border-light); color: var(--text-dim);
    }
    .sidebar-nav { padding: 0.75rem 0; }
    .sidebar-nav a {
      display: flex; align-items: center; gap: 0.5rem;
      padding: 0.5rem 1.25rem; color: var(--text-muted); text-decoration: none;
      font-size: 0.8125rem; transition: all 0.15s ease; border-left: 2px solid transparent;
    }
    .sidebar-nav a:hover {
      color: var(--text-secondary); background: var(--accent-bg-subtle);
      border-left-color: var(--accent);
    }
    .sidebar-nav a .count {
      margin-left: auto; font-size: 0.625rem; color: var(--text-dim);
      background: var(--bg-card); padding: 0.0625rem 0.375rem; border-radius: 4px;
    }
    .sidebar-nav .nav-category {
      padding: 1rem 1.25rem 0.25rem; font-size: 0.625rem;
      font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--text-dim);
    }
    .main { margin-left: 280px; min-height: 100vh; }
    .hero {
      padding: 3rem 3.5rem 2.5rem;
      background: var(--hero-gradient);
      border-bottom: 1px solid var(--border);
    }
    .hero h1 {
      font-size: 2.25rem; font-weight: 800; color: var(--text-primary);
      letter-spacing: -0.03em; line-height: 1.2;
    }
    .hero h1 span { color: var(--accent-light); }
    .hero p {
      margin-top: 0.75rem; color: var(--text-muted); max-width: 720px; font-size: 0.9375rem;
      line-height: 1.8;
    }
    .hero .meta-grid {
      margin-top: 1.5rem; display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
    }
    .hero .meta-item {
      background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 8px;
      padding: 0.75rem 1rem;
    }
    .hero .meta-item .label { font-size: 0.625rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-dim); font-weight: 600; }
    .hero .meta-item .value { font-size: 0.8125rem; color: var(--text-secondary); margin-top: 0.25rem; font-family: 'JetBrains Mono', monospace; }
    .hero .meta-item .value.url { color: var(--accent-light); }
    .flow-section {
      padding: 2.5rem 3.5rem;
      border-bottom: 1px solid var(--border);
      scroll-margin-top: 1rem;
    }
    .flow-section:last-of-type { border-bottom: none; }
    .flow-header {
      display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.75rem;
    }
    .flow-header h2 {
      font-size: 1.375rem; font-weight: 700; color: var(--text-primary);
      letter-spacing: -0.02em;
    }
    .flow-header .step-badge {
      font-size: 0.625rem; font-weight: 600; color: var(--accent-light);
      background: var(--accent-bg); padding: 0.125rem 0.5rem;
      border-radius: 9999px;
    }
    .flow-description {
      font-size: 0.875rem; color: var(--text-muted); max-width: 720px;
      line-height: 1.8; margin-bottom: 1rem;
    }
    .callout {
      background: var(--accent-bg-subtle); border-left: 3px solid var(--accent);
      padding: 0.75rem 1rem; margin: 1rem 0; border-radius: 0 6px 6px 0;
      font-size: 0.8125rem; color: var(--accent-subtle); line-height: 1.7;
    }
    .callout strong { color: var(--accent-light); }
    .callout.prereq {
      background: var(--warning-bg); border-left-color: var(--warning-border);
      color: var(--warning-text);
    }
    .callout.prereq strong { color: var(--warning-text-strong); }
    .steps-container { margin-top: 1.25rem; }
    .flow-step {
      background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 10px;
      padding: 1.25rem 1.5rem; margin-bottom: 1rem;
      transition: border-color 0.15s ease;
    }
    .flow-step:hover { border-color: var(--text-dim); }
    .step-heading {
      display: flex; align-items: center; gap: 0.625rem;
      margin-bottom: 0.75rem;
    }
    .step-number { font-size: 0.5rem; color: var(--accent); }
    .step-title { font-size: 0.875rem; font-weight: 600; color: var(--text-secondary); }
    .step-path {
      font-family: 'JetBrains Mono', monospace; font-size: 0.75rem;
      color: var(--accent-light); background: var(--accent-bg);
      padding: 0.125rem 0.5rem; border-radius: 4px;
    }
    .method-badge {
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 0.5625rem; font-weight: 700; padding: 0.1875rem 0.4375rem;
      border-radius: 4px; text-transform: uppercase; min-width: 42px;
      letter-spacing: 0.06em; font-family: 'JetBrains Mono', monospace;
    }
    .method-GET { background: var(--success-bg); color: var(--success); }
    .method-POST { background: var(--accent-bg); color: var(--accent-light); }
    .method-PATCH { background: var(--warning-bg); color: var(--warning); }
    .method-PUT { background: var(--info-bg); color: var(--info); }
    .method-DELETE { background: var(--danger-bg); color: var(--danger); }
    .code-header {
      font-size: 0.625rem; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--text-dim); margin-bottom: 0.375rem;
      margin-top: 0.75rem;
    }
    .code-block {
      background: var(--bg-code); border: 1px solid var(--border-light); border-radius: 8px;
      padding: 1rem; overflow-x: auto; margin-bottom: 0.25rem;
    }
    .code-block code {
      font-family: 'JetBrains Mono', monospace; font-size: 0.75rem;
      line-height: 1.7; color: var(--accent-subtle); white-space: pre;
    }
    .footer {
      padding: 2rem 3.5rem; text-align: center; color: var(--text-dim); font-size: 0.75rem;
      border-top: 1px solid var(--border);
    }
    .footer a { color: var(--accent); text-decoration: none; }
    .footer a:hover { text-decoration: underline; }
    @media (max-width: 900px) {
      .sidebar { display: none; }
      .main { margin-left: 0; }
      .hero, .flow-section { padding: 1.5rem; }
      .hero .meta-grid { grid-template-columns: 1fr; }
      .flow-step { padding: 1rem; }
      .step-heading { flex-wrap: wrap; }
      .hero h1 { font-size: 1.5rem; }
      .flow-header h2 { font-size: 1.125rem; }
    }
    @media print {
      .sidebar { display: none; }
      .main { margin-left: 0; }
      .flow-section { break-inside: avoid; }
    }
  </style>
</head>
<body>

<aside class="sidebar">
  <div class="sidebar-header">
    <div class="top-row">
      <div class="title-block">
        <h1>ChurchOS API</h1>
        <div class="subtitle">Developer Integration Guide</div>
      </div>
      <button id="theme-toggle" class="theme-toggle" onclick="toggleTheme()" title="Toggle light/dark mode">🌙</button>
    </div>
    <div class="meta-info">
      <span><strong>Base URL:</strong></span>
      <span style="font-family:'JetBrains Mono',monospace;font-size:0.6875rem;color:#64748b;word-break:break-all">${escapeHtml(baseUrl)}</span>
    </div>
    <div class="badge-row">
      <span class="badge">${ALL_FLOWS.length} flows</span>
      <span class="badge">${totalSteps} steps</span>
      <a href="${escapeHtml(swaggerUrl)}" target="_blank" class="badge outline" style="text-decoration:none;cursor:pointer">Swagger UI →</a>
    </div>
  </div>
  <nav class="sidebar-nav">
    ${sidebarNav}
  </nav>
</aside>

<div class="main">
  <div class="hero">
    <h1>Developer <span>Guide</span></h1>
    <p>
      A comprehensive integration guide for the ChurchOS API. This guide walks through
      each feature flow step-by-step, showing the exact API calls, request formats,
      response shapes, and important business rules you need to know when building
      your frontend integration.
    </p>
    <div class="meta-grid">
      <div class="meta-item">
        <div class="label">Base URL</div>
        <div class="value url">${escapeHtml(baseUrl)}</div>
      </div>
      <div class="meta-item">
        <div class="label">Auth Scheme</div>
        <div class="value">Bearer JWT (Supabase)</div>
      </div>
      <div class="meta-item">
        <div class="label">Response Format</div>
        <div class="value">{ success, data, meta? }</div>
      </div>
      <div class="meta-item">
        <div class="label">Flows</div>
        <div class="value">${ALL_FLOWS.length} flows · ${totalSteps} steps</div>
      </div>
    </div>
  </div>

  ${contentHtml}

  <div class="footer">
    ChurchOS: Church Management &amp; Digital Ministry Platform &bull;
    <a href="${escapeHtml(swaggerUrl)}" target="_blank">Interactive Swagger Docs</a> &bull;
    Built with NestJS + Prisma
  </div>
</div>

<script>
function toggleTheme() {
  document.body.classList.toggle('light-mode');
  var btn = document.getElementById('theme-toggle');
  btn.textContent = document.body.classList.contains('light-mode') ? '\u2600\uFE0F' : '\uD83C\uDF19';
  localStorage.setItem('theme', document.body.classList.contains('light-mode') ? 'light' : 'dark');
}
(function() {
  var saved = localStorage.getItem('theme');
  var prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  if (saved === 'light' || (!saved && prefersLight)) {
    document.body.classList.add('light-mode');
    var btn = document.getElementById('theme-toggle');
    if (btn) btn.textContent = '\u2600\uFE0F';
  }
})();
</script>

</body>
</html>`;
}

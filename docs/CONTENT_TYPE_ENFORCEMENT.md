# Content-Type Enforcement API Documentation

## Overview

This document describes the implementation of strict content-type enforcement for JSON endpoints in the Disciplr backend. The middleware ensures that all endpoints requiring request bodies receive properly formatted JSON with the correct `Content-Type` header.

## Security Features

### Content-Type Validation
- **Enforcement**: All POST, PUT, PATCH, and DELETE requests with bodies must include `Content-Type: application/json`
- **Charset Validation**: Only UTF-8 charset is supported for JSON payloads
- **Bypass Prevention**: Middleware prevents bypass attempts using alternate content types

### Error Handling
- **Consistent Error Envelope**: All content-type errors return standardized error responses
- **HTTP Status Codes**: 
  - `415 Unsupported Media Type` for invalid content types
  - `400 Bad Request` for malformed JSON (handled by Express)

## Implementation Details

### Middleware Location
`src/middleware/requireJson.ts`

### Core Functions

#### `requireJson(req, res, next)`
Main middleware function that:
- Allows GET, HEAD, OPTIONS requests to pass through (no body expected)
- Validates `Content-Type` header for requests with bodies
- Returns `415` status for unsupported media types
- Validates charset parameter (UTF-8 only)

#### `requireJsonForMethods(methods)`
Factory function that creates middleware for specific HTTP methods only.

### Applied Endpoints

#### Authentication Routes (`/api/auth/*`)
- `POST /auth/register` - User registration
- `POST /auth/login` - User login  
- `POST /auth/refresh` - Token refresh
- `POST /auth/logout` - User logout
- `POST /auth/logout-all` - Logout from all devices
- `POST /auth/users/:id/role` - Role management

#### Vault Routes (`/api/vaults/*`)
- `POST /api/vaults` - Create new vault
- `POST /api/vaults/:id/cancel` - Cancel vault

#### Jobs Routes (`/api/jobs/*`)
- `POST /api/jobs/enqueue` - Enqueue background job

### Unaffected Routes
All GET, HEAD, and OPTIONS endpoints continue to work without content-type restrictions.

## API Behavior

### Successful Requests

#### Valid JSON Request
```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "password123",
    "name": "Test User"
  }'
```

**Response**: `200` or `201` (depending on endpoint)

#### Valid JSON with Charset
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json; charset=utf-8" \
  -d '{
    "email": "user@example.com", 
    "password": "password123"
  }'
```

**Response**: `200`

### Error Responses

#### Missing Content-Type Header
```bash
curl -X POST http://localhost:3000/api/auth/register \
  -d '{"email": "user@example.com"}'
```

**Response**: `415 Unsupported Media Type`
```json
{
  "error": "Unsupported Media Type: Content-Type must be application/json"
}
```

#### Invalid Content-Type
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: text/plain" \
  -d "email=user@example.com&password=password123"
```

**Response**: `415 Unsupported Media Type`
```json
{
  "error": "Unsupported Media Type: Content-Type must be application/json"
}
```

#### Invalid Charset
```bash
curl -X POST http://localhost:3000/api/auth/refresh \
  -H "Content-Type: application/json; charset=iso-8859-1" \
  -d '{"refreshToken": "token123"}'
```

**Response**: `415 Unsupported Media Type`
```json
{
  "error": "Unsupported Media Type: Only UTF-8 charset is supported for JSON"
}
```

#### Malformed JSON
```bash
curl -X POST http://localhost:3000/api/auth/logout \
  -H "Content-Type: application/json" \
  -d '{"refreshToken": invalid}'
```

**Response**: `400 Bad Request`
```json
{
  "error": "Unexpected token i in JSON at position 18"
}
```

## Testing

### Test Coverage
The implementation includes comprehensive test coverage in `src/tests/contentType.test.ts`:

- **Middleware Unit Tests**: All HTTP methods and content-type scenarios
- **Integration Tests**: Real endpoint testing with auth, vaults, and jobs
- **Edge Cases**: Empty bodies, charset validation, malformed headers
- **Security Tests**: Bypass attempts and alternate content types

### Running Tests
```bash
# Run content-type specific tests
npm test -- src/tests/contentType.test.ts

# Run all tests
npm test
```

### Test Matrix

| Method | Content-Type | Body | Expected Status |
|--------|-------------|------|----------------|
| GET | any | any | 200 (passes through) |
| POST | application/json | valid | 200/201 |
| POST | application/json; charset=utf-8 | valid | 200/201 |
| POST | missing | any | 415 |
| POST | text/plain | any | 415 |
| POST | application/x-www-form-urlencoded | any | 415 |
| POST | application/json | malformed | 400 |
| POST | application/json; charset=iso-8859-1 | any | 415 |

## Security Considerations

### Prevention of Bypass Attempts
The middleware prevents common bypass techniques:
- **Content-Type Spoofing**: Validates actual header content
- **Charset Manipulation**: Only allows UTF-8
- **Parameter Pollution**: Handles multiple content-type parameters
- **Case Sensitivity**: Case-insensitive header matching

### Request Body Detection
Middleware intelligently detects request bodies:
- **Content-Length Header**: Checks for positive content length
- **Empty Bodies**: Allows requests without bodies (Content-Length: 0)
- **Method-Based Logic**: GET/HEAD/OPTIONS bypass content-type checks

## Migration Guide

### For API Consumers
1. **Update Clients**: Ensure all POST/PUT/PATCH/DELETE requests include `Content-Type: application/json`
2. **Error Handling**: Update error handling to expect `415` status codes
3. **Charset**: Ensure JSON payloads use UTF-8 encoding

### For Developers
1. **New Endpoints**: Apply `requireJson` middleware to new endpoints with request bodies
2. **Testing**: Include content-type validation tests for new endpoints
3. **Documentation**: Update API documentation to reflect content-type requirements

## Performance Impact

### Minimal Overhead
- **Header Validation**: Simple string comparison operations
- **Early Exit**: Failed requests terminate before reaching business logic
- **Memory Usage**: No additional memory allocation for validation

### Request Flow
1. **Content-Type Check**: Immediate validation or rejection
2. **Body Processing**: Only proceeds for valid content types
3. **Business Logic**: Standard request handling continues

## Troubleshooting

### Common Issues

#### 415 Errors on Valid Requests
- **Check Headers**: Ensure `Content-Type: application/json` is set
- **Verify Charset**: Use UTF-8 charset if specified
- **Case Sensitivity**: Headers are case-insensitive but value matching is exact

#### Integration Issues
- **Middleware Order**: Ensure `requireJson` is placed before body parsing middleware
- **Express Setup**: Verify `express.json()` middleware is properly configured

### Debug Mode
Enable debug logging to trace middleware execution:
```bash
DEBUG=content-type:* npm run dev
```

## Future Enhancements

### Planned Features
1. **Custom Content Types**: Support for API-specific JSON variants
2. **Rate Limiting Integration**: Enhanced protection for content-type violations
3. **CORS Integration**: Better handling of preflight requests
4. **Metrics Collection**: Track content-type violation attempts

### Extension Points
The middleware is designed for extensibility:
- **Custom Validators**: Easy to add additional content-type validation
- **Method-Specific Rules**: Fine-grained control per HTTP method
- **Error Customization**: Configurable error messages and formats

## Compliance

### Standards Compliance
- **RFC 7231**: Proper HTTP content-type handling
- **RFC 8259**: JSON media type specification compliance
- **Security Best Practices**: Defense against content-type injection attacks

### Audit Checklist
- [x] Content-Type header validation
- [x] Charset validation (UTF-8 only)
- [x] Consistent error responses
- [x] Comprehensive test coverage
- [x] Security bypass prevention
- [x] Performance optimization
- [x] Documentation completeness

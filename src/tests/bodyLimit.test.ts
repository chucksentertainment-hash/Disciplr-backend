import { jest } from '@jest/globals';

// Use dynamic imports as seen in other project tests to handle ES modules correctly with Jest
const { app } = await import('../app.js');
const { errorHandler, ErrorCode } = await import('../middleware/errorHandler.js');
const request = (await import('supertest')).default;

// Add a test route and the error handler to the app instance for this test
// We add it to the existing app instance which already has express.json() configured
app.post('/test-body-limit', (req, res) => {
  res.status(200).json({ status: 'ok', size: JSON.stringify(req.body).length });
});

// We need to add the error handler AFTER the route
app.use(errorHandler);

describe('JSON Body Size Limits', () => {
  it('should accept payloads within the default 500kb limit', async () => {
    // Generate a payload that is ~10kb
    const normalPayload = {
      data: 'a'.repeat(10000), // 10kb of string data
    };

    const res = await request(app)
      .post('/test-body-limit')
      .send(normalPayload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('should reject payloads exceeding the 500kb limit with 413 Error', async () => {
    // Generate a payload that is ~600kb (exceeds 500kb default)
    const largePayload = {
      data: 'a'.repeat(600 * 1024), // 600kb of string data
    };

    const res = await request(app)
      .post('/test-body-limit')
      .send(largePayload);

    expect(res.status).toBe(413);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
    expect(res.body.error.message).toBe('Payload too large');
  });
});

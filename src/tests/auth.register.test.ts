import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import request from 'supertest'
import express from 'express'

// Mock dependencies
const mockPrisma = {
    user: {
        findUnique: jest.fn<any>(),
        create: jest.fn<any>(),
    },
}

jest.unstable_mockModule('../lib/prisma.js', () => ({
    prisma: mockPrisma,
}))

// Mock bcryptjs to control hashing in tests
jest.unstable_mockModule('bcryptjs', () => ({
    default: {
        hash: jest.fn<any>().mockResolvedValue('hashed_password'),
        compare: jest.fn<any>().mockResolvedValue(true),
    },
}))
let app: express.Express
let authRouter: any
let AuthService: any

beforeEach(async () => {
    jest.clearAllMocks()
    
    const authModule = await import('../routes/auth.js')
    authRouter = authModule.authRouter
    const authServiceModule = await import('../services/auth.service.js')
    AuthService = authServiceModule.AuthService

    app = express()
    app.use(express.json())
    app.use('/api/auth', authRouter)
})

describe('POST /api/auth/register', () => {
    const validUser = {
        email: 'test@example.com',
        password: 'password123',
    }

    it('should register a new user successfully', async () => {
        mockPrisma.user.create.mockResolvedValueOnce({
            id: 'user-123',
            email: validUser.email,
            role: 'USER',
        })

        const res = await request(app)
            .post('/api/auth/register')
            .send(validUser)

        expect(res.status).toBe(201)
        expect(res.body).toEqual({
            id: 'user-123',
            email: validUser.email,
            role: 'USER',
        })
        expect(mockPrisma.user.create).toHaveBeenCalledWith({
            data: {
                email: validUser.email,
                passwordHash: 'hashed_password',
                role: 'USER',
            },
        })
    })

    it('should return 409 if email is already in use', async () => {
        const prismaError: any = new Error('Unique constraint failed')
        prismaError.code = 'P2002'
        mockPrisma.user.create.mockRejectedValueOnce(prismaError)

        const res = await request(app)
            .post('/api/auth/register')
            .send(validUser)

        expect(res.status).toBe(409)
        expect(res.body.error).toBe('Email already in use')
    })

    it('should return 400 for invalid input', async () => {
        const res = await request(app)
            .post('/api/auth/register')
            .send({ email: 'invalid-email' })

        expect(res.status).toBe(400)
        expect(res.body.error).toBeDefined()
    })

    it('should not return password hash in response', async () => {
        mockPrisma.user.create.mockResolvedValueOnce({
            id: 'user-123',
            email: validUser.email,
            passwordHash: 'secret_hash',
            role: 'USER',
        })

        const res = await request(app)
            .post('/api/auth/register')
            .send(validUser)

        expect(res.status).toBe(201)
        expect(res.body.passwordHash).toBeUndefined()
    })
})

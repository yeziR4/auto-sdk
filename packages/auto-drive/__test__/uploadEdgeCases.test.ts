import { compressFile } from '@autonomys/auto-dag-data'
import { apiCalls } from '../src/api/calls/index'
import { GenericFile } from '../src/api/models/file'
import { FileUpload } from '../src/api/models/uploads'
import { AutoDriveApiHandler } from '../src/api/types'
import { createApiInterface } from '../src/api/wrappers'
import { progressToPercentage } from '../src/utils/misc'

jest.mock('@autonomys/auto-dag-data', () => ({
  compressFile: jest.fn((iterable) => iterable),
  CompressionAlgorithm: { ZLIB: 'ZLIB' },
  EncryptionAlgorithm: { AES_256_GCM: 'AES_256_GCM' },
  encryptFile: jest.fn((iterable) => iterable),
}))

describe('upload edge cases and progress', () => {
  const dummyHandler: AutoDriveApiHandler = {
    sendAPIRequest: jest.fn(),
    sendDownloadRequest: jest.fn(),
    baseUrl: 'https://example.com/api',
    downloadBaseUrl: 'https://example.com/downloads',
  }

  const api = createApiInterface(dummyHandler)

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('progressToPercentage', () => {
    it('returns 100 when target is 0 or negative', () => {
      expect(progressToPercentage(0, 0)).toBe(100)
      expect(progressToPercentage(8, 0)).toBe(100)
      expect(progressToPercentage(0, -10)).toBe(100)
    })

    it('calculates percentage correctly and clamps between 0 and 100', () => {
      expect(progressToPercentage(50, 100)).toBe(50)
      expect(progressToPercentage(150, 100)).toBe(100)
      expect(progressToPercentage(-10, 100)).toBe(0)
    })
  })

  describe('raw bytes progress tracking', () => {
    it('reports progress based on raw bytes read rather than compressed bytes', async () => {
      // Raw file is 11 bytes ('hello world')
      const rawContent = Buffer.from('hello world')
      const file: GenericFile = {
        name: 'hello.txt',
        size: rawContent.length,
        read: async function* () {
          yield rawContent
        },
      }

      // Mock compressFile to yield 19 bytes (more than 11 bytes raw size) after consuming source
      jest.mocked(compressFile).mockImplementationOnce(async function* (source) {
        for await (const chunk of source) {
          void chunk
        }
        yield Buffer.alloc(19)
      })

      jest.spyOn(apiCalls, 'createFileUpload').mockResolvedValue({ id: 'upload-id' } as FileUpload)
      jest.spyOn(apiCalls, 'uploadFileChunk').mockResolvedValue()
      jest.spyOn(apiCalls, 'completeUpload').mockResolvedValue({ cid: 'test-cid' })

      const onProgress = jest.fn()
      await api.uploadFile(file, { compression: true, onProgress })

      // Progress should be 100% based on 11 raw bytes read / 11 raw size (not 172.7%)
      expect(onProgress).toHaveBeenLastCalledWith(100)
    })
  })

  describe('empty file handling', () => {
    it('reports 100 progress for empty file upload with compression', async () => {
      const file = new File([], 'empty.txt')

      // Zlib produces 8 bytes for an empty file
      jest.mocked(compressFile).mockImplementationOnce(async function* () {
        yield Buffer.alloc(8)
      })

      jest.spyOn(apiCalls, 'createFileUpload').mockResolvedValue({ id: 'upload-id' } as FileUpload)
      jest.spyOn(apiCalls, 'uploadFileChunk').mockResolvedValue()
      jest.spyOn(apiCalls, 'completeUpload').mockResolvedValue({ cid: 'empty-cid' })

      const onProgress = jest.fn()
      await api.uploadFileFromInput(file, { compression: true, onProgress })

      expect(onProgress).toHaveBeenLastCalledWith(100)
    })
  })

  describe('empty string password validation', () => {
    it('rejects uploadFile with empty password', async () => {
      const file: GenericFile = {
        name: 'test.txt',
        size: 4,
        read: async function* () {
          yield Buffer.from('test')
        },
      }

      await expect(api.uploadFile(file, { password: '' })).rejects.toThrow(
        'Password cannot be empty',
      )
    })

    it('rejects uploadFileFromInput with empty password', async () => {
      const file = new File(['test'], 'test.txt')

      await expect(api.uploadFileFromInput(file, { password: '' })).rejects.toThrow(
        'Password cannot be empty',
      )
    })

    it('rejects uploadFolderFromInput with empty password', async () => {
      const file = new File(['test'], 'test.txt')

      await expect(api.uploadFolderFromInput([file], { password: '' })).rejects.toThrow(
        'Password cannot be empty',
      )
    })
  })

  describe('session ID attached to failed upload error', () => {
    it('attaches uploadId when chunk upload fails', async () => {
      const file = new File(['test'], 'test.txt')
      jest
        .spyOn(apiCalls, 'createFileUpload')
        .mockResolvedValue({ id: 'session-123' } as FileUpload)
      jest
        .spyOn(apiCalls, 'uploadFileChunk')
        .mockRejectedValue(new Error('Network error during chunk upload'))

      let caughtError: unknown
      try {
        await api.uploadFileFromInput(file, { compression: false })
      } catch (e) {
        caughtError = e
      }

      expect(caughtError).toBeInstanceOf(Error)
      expect((caughtError as { uploadId?: string }).uploadId).toBe('session-123')
    })

    it('attaches uploadId when completeUpload fails', async () => {
      const file = new File(['test'], 'test.txt')
      jest
        .spyOn(apiCalls, 'createFileUpload')
        .mockResolvedValue({ id: 'session-456' } as FileUpload)
      jest.spyOn(apiCalls, 'uploadFileChunk').mockResolvedValue()
      jest.spyOn(apiCalls, 'completeUpload').mockRejectedValue(new Error('Complete upload failed'))

      let caughtError: unknown
      try {
        await api.uploadFileFromInput(file, { compression: false })
      } catch (e) {
        caughtError = e
      }

      expect(caughtError).toBeInstanceOf(Error)
      expect((caughtError as { uploadId?: string }).uploadId).toBe('session-456')
    })
  })

  describe('onProgress callback error isolation', () => {
    it('does not abort upload when caller onProgress callback throws', async () => {
      const file = new File(['hello world'], 'hello.txt')
      jest.spyOn(apiCalls, 'createFileUpload').mockResolvedValue({ id: 'upload-id' } as FileUpload)
      jest.spyOn(apiCalls, 'uploadFileChunk').mockResolvedValue()
      jest.spyOn(apiCalls, 'completeUpload').mockResolvedValue({ cid: 'success-cid' })

      const faultyProgress = jest.fn(() => {
        throw new Error('Caller UI crashed inside onProgress')
      })

      await expect(
        api.uploadFileFromInput(file, { compression: false, onProgress: faultyProgress }),
      ).resolves.toBe('success-cid')
      expect(faultyProgress).toHaveBeenCalled()
    })
  })

  describe('MIME type resolution', () => {
    it('preserves generic file mimeType if provided', async () => {
      const file: GenericFile = {
        name: 'config',
        mimeType: 'application/json',
        size: 15,
        read: async function* () {
          yield Buffer.from('{"key":"value"}')
        },
      }

      const createSpy = jest
        .spyOn(apiCalls, 'createFileUpload')
        .mockResolvedValue({ id: 'upload-id' } as FileUpload)
      jest.spyOn(apiCalls, 'uploadFileChunk').mockResolvedValue()
      jest.spyOn(apiCalls, 'completeUpload').mockResolvedValue({ cid: 'config-cid' })

      await api.uploadFile(file, { compression: false })

      expect(createSpy).toHaveBeenCalledWith(
        dummyHandler,
        expect.objectContaining({
          mimeType: 'application/json',
          filename: 'config',
        }),
      )
    })

    it('passes browser File.type in uploadFileFromInput', async () => {
      const file = new File(['image-bytes'], 'screenshot', { type: 'image/png' })

      const createSpy = jest
        .spyOn(apiCalls, 'createFileUpload')
        .mockResolvedValue({ id: 'upload-id' } as FileUpload)
      jest.spyOn(apiCalls, 'uploadFileChunk').mockResolvedValue()
      jest.spyOn(apiCalls, 'completeUpload').mockResolvedValue({ cid: 'screenshot-cid' })

      await api.uploadFileFromInput(file, { compression: false })

      expect(createSpy).toHaveBeenCalledWith(
        dummyHandler,
        expect.objectContaining({
          mimeType: 'image/png',
          filename: 'screenshot',
        }),
      )
    })

    it('preserves application/json mimeType in uploadObjectAsJSON', async () => {
      const createSpy = jest
        .spyOn(apiCalls, 'createFileUpload')
        .mockResolvedValue({ id: 'upload-id' } as FileUpload)
      jest.spyOn(apiCalls, 'uploadFileChunk').mockResolvedValue()
      jest.spyOn(apiCalls, 'completeUpload').mockResolvedValue({ cid: 'json-cid' })

      await api.uploadObjectAsJSON({ hello: 'world' }, 'settings', { compression: false })

      expect(createSpy).toHaveBeenCalledWith(
        dummyHandler,
        expect.objectContaining({
          mimeType: 'application/json',
          filename: 'settings',
        }),
      )
    })
  })
})

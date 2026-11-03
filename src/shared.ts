export type Arm = 'left' | 'right' | 'unknown'

export type Reading = {
  id: string
  capturedAt: string
  sys: number
  dia: number
  pul: number
  arm: Arm
}

export type UploadJob = {
  id: string
  status: 'processing' | 'saved' | 'error'
  uploadedAt: string
  error?: string
  reading?: Reading
}

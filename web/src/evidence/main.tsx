import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { EvidenceApp } from './EvidenceApp'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <EvidenceApp />
  </StrictMode>,
)


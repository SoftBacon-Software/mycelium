import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from './stores/authStore'
import AppLayout from './layouts/AppLayout'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'
import TasksPage from './pages/TasksPage'
import ChannelsPage from './pages/ChannelsPage'
import MessagesPage from './pages/MessagesPage'
import PlansPage from './pages/PlansPage'
import BugsPage from './pages/BugsPage'
import AssetsPage from './pages/AssetsPage'
import OperatorsPage from './pages/OperatorsPage'
import ApprovalsPage from './pages/ApprovalsPage'
import DronesPage from './pages/DronesPage'
import ConceptsPage from './pages/ConceptsPage'
import ContextPage from './pages/ContextPage'

export default function App() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const hydrate = useAuthStore((s) => s.hydrate)

  useEffect(() => {
    hydrate()
  }, [hydrate])

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/login"
          element={isAuthenticated ? <Navigate to="/" replace /> : <LoginPage />}
        />
        <Route
          element={isAuthenticated ? <AppLayout /> : <Navigate to="/login" replace />}
        >
          <Route index element={<DashboardPage />} />
          <Route path="channels" element={<ChannelsPage />} />
          <Route path="tasks" element={<TasksPage />} />
          <Route path="messages" element={<MessagesPage />} />
          <Route path="plans" element={<PlansPage />} />
          <Route path="bugs" element={<BugsPage />} />
          <Route path="assets" element={<AssetsPage />} />
          <Route path="operators" element={<OperatorsPage />} />
          <Route path="approvals" element={<ApprovalsPage />} />
          <Route path="drones" element={<DronesPage />} />
          <Route path="concepts" element={<ConceptsPage />} />
          <Route path="context" element={<ContextPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

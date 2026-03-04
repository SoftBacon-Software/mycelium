import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Toaster } from 'sonner'
import { useAuthStore } from './stores/authStore'
import AppLayout from './layouts/AppLayout'

// Eager: login is the entry point
import LoginPage from './pages/LoginPage'

// Lazy: all other pages loaded on demand
const DashboardPage = lazy(() => import('./pages/DashboardPage'))
const InboxPage = lazy(() => import('./pages/InboxPage'))
const ChannelsPage = lazy(() => import('./pages/ChannelsPage'))
const TasksPage = lazy(() => import('./pages/TasksPage'))
const MessagesPage = lazy(() => import('./pages/MessagesPage'))
const PlansPage = lazy(() => import('./pages/PlansPage'))
const BugsPage = lazy(() => import('./pages/BugsPage'))
const AssetsPage = lazy(() => import('./pages/AssetsPage'))
const OperatorsPage = lazy(() => import('./pages/OperatorsPage'))
const ApprovalsPage = lazy(() => import('./pages/ApprovalsPage'))
const DronesPage = lazy(() => import('./pages/DronesPage'))
const ConceptsPage = lazy(() => import('./pages/ConceptsPage'))
const ContextPage = lazy(() => import('./pages/ContextPage'))
const WebhooksPage = lazy(() => import('./pages/WebhooksPage'))
const AdminOpsPage = lazy(() => import('./pages/AdminOpsPage'))
const NetworkHealthPage = lazy(() => import('./pages/NetworkHealthPage'))
const OnboardingPage = lazy(() => import('./pages/OnboardingPage'))
const PluginsPage = lazy(() => import('./pages/PluginsPage'))
const SpawnsPage = lazy(() => import('./pages/SpawnsPage'))
const AnalyticsPage = lazy(() => import('./pages/AnalyticsPage'))
const FeedbackPage = lazy(() => import('./pages/FeedbackPage'))

export default function App() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const hydrate = useAuthStore((s) => s.hydrate)

  useEffect(() => {
    hydrate()
  }, [hydrate])

  return (
    <BrowserRouter basename="/studio">
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: '#2A2420',
            border: '1px solid #332B25',
            color: '#F0E8DB',
          },
        }}
      />
      <Suspense>
        <Routes>
          <Route
            path="/login"
            element={isAuthenticated ? <Navigate to="/" replace /> : <LoginPage />}
          />
          <Route
            element={isAuthenticated ? <AppLayout /> : <Navigate to="/login" replace />}
          >
            <Route index element={<DashboardPage />} />
            <Route path="inbox" element={<InboxPage />} />
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
            <Route path="webhooks" element={<WebhooksPage />} />
            <Route path="ops" element={<AdminOpsPage />} />
            <Route path="health" element={<NetworkHealthPage />} />
            <Route path="onboarding" element={<OnboardingPage />} />
            <Route path="plugins" element={<PluginsPage />} />
            <Route path="spawns" element={<SpawnsPage />} />
            <Route path="analytics" element={<AnalyticsPage />} />
            <Route path="feedback" element={<FeedbackPage />} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  )
}

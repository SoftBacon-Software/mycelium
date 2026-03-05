import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useDashboardStore } from '../stores/dashboardStore'

export default function PluginPageView() {
  const { pluginName, '*': pagePath } = useParams()
  const plugins = useDashboardStore((s) => s.plugins)
  const [data, setData] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const plugin = plugins.find((p) => p.name === pluginName)
  const routePrefix = plugin?.route_prefix || `/${pluginName}`

  useEffect(() => {
    setLoading(true)
    setError(null)
    const url = `/api/mycelium${routePrefix}/${pagePath || ''}`
    fetch(url, {
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
    })
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
        return r.json()
      })
      .then((d) => {
        setData(d)
        setLoading(false)
      })
      .catch((e) => {
        setError(e.message)
        setLoading(false)
      })
  }, [pluginName, pagePath, routePrefix])

  if (loading) return <div className="p-8 text-text-dim">Loading...</div>
  if (error) return <div className="p-8 text-red">{error}</div>

  return (
    <div className="p-8">
      <h1 className="text-2xl font-semibold text-text mb-6">
        {plugin?.display_name || pluginName}
      </h1>
      <pre className="bg-surface-raised rounded-lg p-4 text-sm text-text-dim overflow-auto whitespace-pre-wrap">
        {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  )
}

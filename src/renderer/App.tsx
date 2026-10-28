import { createHashRouter, createRoutesFromElements, Navigate, Route, RouterProvider } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Projects from './pages/Projects';
import Presets from './pages/Presets';
import PresetEditor from './pages/PresetEditor';
import ProjectEditor from './pages/ProjectEditor';
import Workspace from './pages/project/Workspace';
import Review from './pages/project/Review';
import Export from './pages/project/Export';
import Settings from './pages/Settings';

// A data router (rather than <HashRouter>) enables useBlocker for unsaved-change protection.
const router = createHashRouter(
  createRoutesFromElements(
    <Route element={<Layout />}>
      <Route path="/" element={<Dashboard />} />
      <Route path="/projects" element={<Projects />} />
      <Route path="/projects/:id" element={<ProjectEditor />}>
        <Route index element={<Workspace />} />
        <Route path="review" element={<Review />} />
        <Route path="export" element={<Export />} />
      </Route>
      <Route path="/presets" element={<Presets />} />
      <Route path="/presets/new" element={<PresetEditor />} />
      <Route path="/presets/:id" element={<PresetEditor />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Route>
  )
);

export default function App() {
  return <RouterProvider router={router} />;
}

import React from 'react';
import { Routes, Route } from 'react-router-dom';
import ClassList from '../../components/watcher/ClassList';
import ClassDetail from '../../components/watcher/ClassDetail';
import AssignmentDetail from '../../components/watcher/AssignmentDetail';
import AssignmentMonitoring from '../../components/watcher/AssignmentMonitoring';

const WatcherPage = () => {
  return (
    <Routes>
      <Route path="/" element={<ClassList />} />
      <Route path="/class/:courseId" element={<ClassDetail />} />
      <Route path="/class/:courseId/assignment/:assignmentId" element={<AssignmentDetail />} />
      <Route path="/class/:courseId/assignment/:assignmentId/monitoring/:userId" element={<AssignmentMonitoring />} />
    </Routes>
  );
};

export default WatcherPage; 
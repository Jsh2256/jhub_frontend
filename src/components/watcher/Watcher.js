import React from 'react';
import { Routes, Route } from 'react-router-dom';
import ClassList from './ClassList';
import ClassDetail from './ClassDetail';
import MonitoringData from './MonitoringData';

const Watcher = () => {
  return (
    <Routes>
      <Route path="/" element={<ClassList />} />
      <Route path="/class/:courseId" element={<ClassDetail />} />
    </Routes>
  );
};

export default Watcher; 
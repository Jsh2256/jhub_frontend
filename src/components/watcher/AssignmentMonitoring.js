import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import {
  Container,
  Paper,
  Box,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Button,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  useTheme,
  Typography,
  Chip,
  CircularProgress,
  IconButton,
  Tooltip
} from '@mui/material';
import Chart from 'chart.js/auto';
import 'chartjs-adapter-date-fns';
import { ko } from 'date-fns/locale';
import { timeUnits } from '../../mocks/monitoringData';
import WatcherBreadcrumbs from '../common/WatcherBreadcrumbs';
import zoomPlugin from 'chartjs-plugin-zoom';
import crosshairPlugin from 'chartjs-plugin-crosshair';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import RefreshIcon from '@mui/icons-material/Refresh';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import api from '../../api/axios';

Chart.register(zoomPlugin);
Chart.register(crosshairPlugin);

const AssignmentMonitoring = () => {
  const { courseId, assignmentId, userId } = useParams();
  const [timeUnit, setTimeUnit] = useState('minute');
  const [minuteValue, setMinuteValue] = useState('5');
  const totalBytesChartRef = useRef(null);
  const changeChartRef = useRef(null);
  const totalChartInstance = useRef(null);
  const changeChartInstance = useRef(null);
  const [data, setData] = useState(null);
  const isUpdating = useRef(false);
  const theme = useTheme();
  const isDarkMode = useMemo(() => theme.palette.mode === 'dark', [theme.palette.mode]);
  const [assignment, setAssignment] = useState(null);
  const [course, setCourse] = useState(null);
  const [student, setStudent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const autoRefreshIntervalRef = useRef(null);
  const currentViewRef = useRef({ xMin: null, xMax: null });

  // 타임스탬프 변환 함수 (20250306_1519 형식을 Date 객체로 변환)
  const parseTimestamp = (timestamp) => {
    const year = parseInt(timestamp.substring(0, 4));
    const month = parseInt(timestamp.substring(4, 6)) - 1; // 월은 0부터 시작
    const day = parseInt(timestamp.substring(6, 8));
    const hour = parseInt(timestamp.substring(9, 11));
    const minute = parseInt(timestamp.substring(11, 13));
    
    return new Date(year, month, day, hour, minute).getTime();
  };

  // 데이터 다운샘플링 함수
  const downsampleData = (data, targetPoints = 500) => {
    if (!data || data.length <= targetPoints) return data;
    
    const skip = Math.ceil(data.length / targetPoints);
    return data.filter((_, index) => index % skip === 0);
  };

  // y축 ticks callback 함수 수정
  const formatBytes = (bytes) => {
    if (!Number.isInteger(bytes)) return '';
    if (Math.abs(bytes) >= 1048576) { // 1MB = 1024 * 1024
      return `${(bytes / 1048576).toFixed(1)}MB`;
    } else if (Math.abs(bytes) >= 1024) { // 1KB
      return `${(bytes / 1024).toFixed(1)}KB`;
    }
    return `${bytes}B`;
  };

  // 차트 옵션 설정 - useMemo로 최적화
  const getChartOptions = (isTotal = true) => {
    const calculateStepSize = (chart) => {
      if (!chart || !chart.data || !chart.data.datasets || chart.data.datasets.length === 0) return 100;
      
      // x축의 현재 범위 내에서의 데이터만 필터링
      const xMin = chart.scales.x.min;
      const xMax = chart.scales.x.max;
      const visibleData = chart.data.datasets[0].data.filter((_, index) => {
        const timestamp = chart.data.labels[index];
        return timestamp >= xMin && timestamp <= xMax;
      });
      
      // 보이는 범위 내의 최대/최소값 계산
      const max = Math.max(...visibleData);
      const min = Math.min(...visibleData);
      const range = max - min;
      
      const targetTicks = 15;
      let stepSize = Math.ceil(range / targetTicks);
      
      const magnitude = Math.pow(10, Math.floor(Math.log10(stepSize)));
      const normalized = stepSize / magnitude;
      
      if (normalized <= 1) stepSize = magnitude;
      else if (normalized <= 2) stepSize = 2 * magnitude;
      else if (normalized <= 5) stepSize = 5 * magnitude;
      else stepSize = 10 * magnitude;
      
      return stepSize;
    };

    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: {
        padding: {
          left: 0,
          right: 60,
          top: isTotal ? 20 : 10,
          bottom: isTotal ? 0 : 20
        }
      },
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        tooltip: {
          enabled: true,
          mode: 'index',
          intersect: false,
          position: 'nearest',
          animation: false,
          backgroundColor: isDarkMode ? '#44475A' : '#FFFFFF',
          borderColor: isDarkMode ? '#6272A4' : '#E0E0E0',
          borderWidth: 1,
          titleColor: isDarkMode ? '#F8F8F2' : '#282A36',
          bodyColor: isDarkMode ? '#F8F8F2' : '#282A36',
          external: (context) => {
            if (isUpdating.current) return;
            isUpdating.current = true;

            try {
              const targetChart = context.chart === totalChartInstance.current 
                ? changeChartInstance.current 
                : totalChartInstance.current;
              
              if (targetChart && context.tooltip && context.tooltip.dataPoints && context.tooltip.dataPoints.length > 0) {
                const tooltip = targetChart.tooltip;
                if (context.tooltip.opacity === 0) {
                  tooltip.setActiveElements([], { x: 0, y: 0 });
                  targetChart.update('none');
                  return;
                }

                // 안전하게 데이터 포인트 확인
                const validDataPoints = context.tooltip.dataPoints.filter(dataPoint => 
                  dataPoint !== undefined && 
                  dataPoint.datasetIndex !== undefined && 
                  dataPoint.dataIndex !== undefined
                );

                if (validDataPoints.length > 0) {
                  const activeElements = validDataPoints.map(dataPoint => ({
                    datasetIndex: dataPoint.datasetIndex,
                    index: dataPoint.dataIndex,
                  }));

                  tooltip.setActiveElements(activeElements, {
                    x: context.tooltip.x,
                    y: context.tooltip.y,
                  });
                  targetChart.update('none');
                }
              }
            } catch (error) {
              console.error('툴팁 업데이트 중 오류 발생:', error);
            } finally {
              isUpdating.current = false;
            }
          },
          callbacks: {
            label: (context) => {
              if (!context || !context.dataset || context.parsed === undefined || context.parsed.y === undefined) {
                return '';
              }
              const label = context.dataset.label || '';
              const value = context.parsed.y;
              return `${label}: ${formatBytes(value)}`;
            }
          }
        },
        crosshair: {
          line: {
            color: isDarkMode ? '#6272A4' : '#9E9E9E',
            width: 1,
            dashPattern: [5, 5]
          },
          sync: {
            enabled: true,
            group: 1,
          },
          zoom: {
            enabled: false
          }
        },
        zoom: {
          limits: {
            x: { min: 'original', max: 'original' },
            y: { min: 'original', max: 'original' }
          },
          pan: {
            enabled: true,
            mode: 'xy',
            onPan({ chart }) {
              if (isUpdating.current) return;
              isUpdating.current = true;

              try {
                const targetChart = chart === totalChartInstance.current 
                  ? changeChartInstance.current 
                  : totalChartInstance.current;
                
                if (targetChart) {
                  const xMin = Math.trunc(chart.scales.x.min);
                  const xMax = Math.trunc(chart.scales.x.max);
                  targetChart.options.scales.x.min = xMin;
                  targetChart.options.scales.x.max = xMax;
                  
                  // y축 범위 업데이트
                  calculateYAxisRange(chart, chart === totalChartInstance.current);
                  calculateYAxisRange(targetChart, targetChart === totalChartInstance.current);
                  
                  // 차트 업데이트
                  chart.update('none');
                  targetChart.update('none');
                }
              } finally {
                isUpdating.current = false;
              }
            }
          },
          zoom: {
            wheel: {
              enabled: true
            },
            pinch: {
              enabled: true
            },
            mode: 'x',
            drag: {
              enabled: false
            },
            onZoom({ chart }) {
              if (isUpdating.current) return;
              isUpdating.current = true;

              try {
                const targetChart = chart === totalChartInstance.current 
                  ? changeChartInstance.current 
                  : totalChartInstance.current;
                
                if (targetChart) {
                  const xMin = Math.trunc(chart.scales.x.min);
                  const xMax = Math.trunc(chart.scales.x.max);
                  targetChart.options.scales.x.min = xMin;
                  targetChart.options.scales.x.max = xMax;
                  
                  // y축 범위 업데이트
                  calculateYAxisRange(chart, chart === totalChartInstance.current);
                  calculateYAxisRange(targetChart, targetChart === totalChartInstance.current);
                  
                  // 차트 업데이트
                  chart.update('none');
                  targetChart.update('none');
                }
              } finally {
                isUpdating.current = false;
              }
            }
          }
        }
      },
      scales: {
        x: {
          type: 'time',
          time: {
            unit: timeUnit,
            displayFormats: {
              minute: 'HH:mm',
              hour: 'MM-dd HH:mm',
              day: 'MM-dd',
              week: 'yyyy-MM-dd',
              month: 'yyyy-MM'
            },
            tooltipFormat: 'yyyy-MM-dd HH:mm',
            adapters: {
              date: {
                locale: ko
              }
            }
          },
          ticks: {
            source: 'auto',
            autoSkip: false,
            maxRotation: 0,
            color: isDarkMode ? '#F8F8F2' : '#282A36'
          },
          grid: {
            display: true,
            color: isDarkMode ? 'rgba(98, 114, 164, 0.1)' : 'rgba(189, 147, 249, 0.1)'
          },
          border: {
            color: isDarkMode ? '#6272A4' : '#BD93F9'
          },
          adapters: {
            date: {
              locale: ko
            }
          }
        },
        y: {
          position: 'right',
          beginAtZero: isTotal,
          display: true,
          ticks: {
            padding: 8,
            callback: (value) => formatBytes(value),
            stepSize: 500,
            display: true,
            z: 1,
            color: isDarkMode ? '#F8F8F2' : '#282A36',
            autoSkip: true
          },
          grid: {
            display: true,
            drawBorder: false,
            color: isDarkMode ? 'rgba(98, 114, 164, 0.2)' : 'rgba(98, 114, 164, 0.25)',
            drawTicks: true,
            tickColor: isDarkMode ? 'rgba(98, 114, 164, 0.4)' : 'rgba(98, 114, 164, 0.4)',
            borderColor: isDarkMode ? 'rgba(98, 114, 164, 0.4)' : 'rgba(98, 114, 164, 0.4)',
            borderWidth: 1,
            z: 0
          },
          border: {
            display: true,
            color: isDarkMode ? '#6272A4' : '#E0E0E0',
            width: 1,
            dash: [2, 4]
          },
          afterDataLimits: (scale) => {
            const chart = scale.chart;
            const xMin = chart.scales.x.min;
            const xMax = chart.scales.x.max;
            const visibleData = chart.data.datasets[0].data.filter((_, index) => {
              const timestamp = chart.data.labels[index];
              return timestamp >= xMin && timestamp <= xMax;
            });
            
            if (visibleData.length > 0) {
              if (isTotal) {
                const max = Math.max(...visibleData);
                const roundedMax = Math.ceil((max * 1.1) / 500) * 500;
                scale.min = 0;
                scale.max = roundedMax;
              } else {
                const maxPositive = Math.max(...visibleData, 0);
                const maxNegative = Math.abs(Math.min(...visibleData, 0));
                const maxValue = Math.max(maxPositive, maxNegative);
                const roundedMax = Math.ceil((maxValue * 1.1) / 500) * 500;
                
                scale.min = -roundedMax;
                scale.max = roundedMax;
              }
            }
          }
        }
      }
    };
  };

  // 차트 생성 함수
  const createChart = (canvas, config) => {
    if (!canvas) return null;
    if (!data || data.length === 0 || !assignment) return null;
    
    const ctx = canvas.getContext('2d');
    
    // 과제 시작일과 마감일 가져오기
    const startTime = new Date(assignment.startDateTime).getTime();
    const endTime = new Date(assignment.endDateTime).getTime();

    console.log('Assignment Info:', {
      startDateTime: assignment.startDateTime,
      endDateTime: assignment.endDateTime,
      parsedStartTime: new Date(startTime).toLocaleString(),
      parsedEndTime: new Date(endTime).toLocaleString(),
      startTime,
      endTime
    });

    const isBar = config.type === 'bar';
    const options = {
      ...getChartOptions(config.type === 'line'),
      scales: {
        ...getChartOptions(config.type === 'line').scales,
        x: {
          ...getChartOptions(config.type === 'line').scales.x,
          min: startTime,
          max: endTime,
          display: true,
          offset: isBar,
          grid: {
            ...getChartOptions(config.type === 'line').scales.x.grid,
            offset: isBar
          }
        },
        y: {
          ...getChartOptions(config.type === 'line').scales.y,
          display: true,
          ticks: {
            ...getChartOptions(config.type === 'line').scales.y.ticks,
            display: true
          }
        }
      },
      plugins: {
        ...getChartOptions(config.type === 'line').plugins,
        zoom: {
          ...getChartOptions(config.type === 'line').plugins.zoom,
          limits: {
            x: {
              min: startTime,
              max: endTime,
              minRange: 60 * 1000 // 최소 1분
            },
            y: { min: 'original', max: 'original' }
          }
        }
      }
    };

    if (isBar) {
      config.data.datasets[0].barPercentage = 0.8;
      config.data.datasets[0].categoryPercentage = 0.9;
      
      // 막대 그래프의 y축 설정을 라인 그래프와 동일하게 설정
      options.scales.y = {
        ...getChartOptions(false).scales.y,  // 라인 그래프와 동일한 기본 설정 사용
        position: 'right',
        display: true,
        ticks: {
          padding: 8,
          callback: (value) => formatBytes(value),
          stepSize: 500,
          display: true,
          z: 1,
          color: isDarkMode ? '#F8F8F2' : '#282A36',
          autoSkip: true
        },
        grid: {
          display: true,
          drawBorder: false,
          color: isDarkMode ? 'rgba(98, 114, 164, 0.2)' : 'rgba(98, 114, 164, 0.25)',
          drawTicks: true,
          tickColor: isDarkMode ? 'rgba(98, 114, 164, 0.4)' : 'rgba(98, 114, 164, 0.4)',
          borderColor: isDarkMode ? 'rgba(98, 114, 164, 0.4)' : 'rgba(98, 114, 164, 0.4)',
          borderWidth: 1,
          z: 0
        },
        border: {
          display: true,
          color: isDarkMode ? '#6272A4' : '#E0E0E0',
          width: 1,
          dash: [2, 4]
        }
      };
      
      // 양수/음수 데이터가 없어도 0을 중심으로 대칭되게 설정
      const data = config.data.datasets[0].data;
      const max = Math.max(...data, 0);
      const min = Math.min(...data, 0);
      const absMax = Math.max(Math.abs(max), Math.abs(min));
      
      options.scales.y.min = -absMax * 1.1;
      options.scales.y.max = absMax * 1.1;
    }

    return new Chart(ctx, {
      ...config,
      options
    });
  };
  // 차트 업데이트 함수
  const updateCharts = () => {
    if (!data || !assignment) return;
    const sampledData = downsampleData(data);
    
    // 과제 시작일과 마감일 가져오기
    const startTime = new Date(assignment.startDateTime).getTime();
    const endTime = Math.max(new Date(assignment.endDateTime).getTime(), new Date().getTime());
    
    console.log('차트 업데이트:', {
      dataLength: sampledData.length,
      startTime: new Date(startTime).toLocaleString(),
      endTime: new Date(endTime).toLocaleString(),
      currentView: currentViewRef.current
    });
    
    const updateChartInstance = (chart, isTotal) => {
      if (!chart) return;

      try {
        // 현재 뷰 저장
        const currentXMin = chart.scales.x.min;
        const currentXMax = chart.scales.x.max;
        const hasCustomView = currentXMin !== undefined && currentXMax !== undefined &&
                             (currentXMin !== startTime || currentXMax !== endTime);

        // 데이터 업데이트
        chart.data.labels = sampledData.map(d => d.timestamp);
        if (isTotal) {
          chart.data.datasets[0].data = sampledData.map(d => d.totalBytes);
        } else {
          chart.data.datasets[0].data = sampledData.map(d => d.change);
          chart.data.datasets[0].backgroundColor = sampledData.map(d => 
            d.change >= 0 
              ? isDarkMode ? 'rgba(80, 250, 123, 0.5)' : 'rgba(98, 114, 164, 0.5)'
              : isDarkMode ? 'rgba(255, 85, 85, 0.5)' : 'rgba(255, 121, 198, 0.5)'
          );
          chart.data.datasets[0].borderColor = sampledData.map(d =>
            d.change >= 0 
              ? isDarkMode ? '#50FA7B' : '#6272A4'
              : isDarkMode ? '#FF5555' : '#FF79C6'
          );
        }

        // 옵션 업데이트
        Object.assign(chart.options, getChartOptions(isTotal));
        
        // 시간 범위 설정 (과제 시작일과 마감일 사이)
        if (!hasCustomView) {
          chart.options.scales.x.min = startTime;
          chart.options.scales.x.max = endTime;
        } else {
          // 사용자가 설정한 뷰 유지
          chart.options.scales.x.min = currentXMin;
          chart.options.scales.x.max = currentXMax;
        }

        // 줌 제한 설정
        chart.options.plugins.zoom.limits = {
          x: {
            min: startTime,
            max: Math.max(endTime, new Date().getTime()),
            minRange: 60 * 1000 // 최소 1분
          },
          y: { min: 'original', max: 'original' }
        };

        // 툴팁 초기화
        chart.tooltip.setActiveElements([], { x: 0, y: 0 });

        requestAnimationFrame(() => {
          chart.update('none');
        });
      } catch (error) {
        console.error('차트 업데이트 중 오류:', error);
      }
    };

    // 차트 업데이트 또는 생성
    if (totalChartInstance.current) {
      updateChartInstance(totalChartInstance.current, true);
    } else if (totalBytesChartRef.current) {
      totalChartInstance.current = createChart(totalBytesChartRef.current, {
        type: 'line',
        data: {
          labels: sampledData.map(d => d.timestamp),
          datasets: [{
            label: '총 코드량 (바이트)',
            data: sampledData.map(d => d.totalBytes),
            borderColor: isDarkMode ? '#BD93F9' : '#6272A4',
            borderWidth: 2,
            pointRadius: 0,
            fill: false,
            stepped: 'before'
          }]
        }
      });
    }

    if (changeChartInstance.current) {
      updateChartInstance(changeChartInstance.current, false);
    } else if (changeChartRef.current) {
      changeChartInstance.current = createChart(changeChartRef.current, {
        type: 'bar',
        data: {
          labels: sampledData.map(d => d.timestamp),
          datasets: [{
            label: '코드 변화량 (바이트)',
            data: sampledData.map(d => d.change),
            backgroundColor: sampledData.map(d => d.change >= 0 ? 'rgba(54, 162, 235, 0.5)' : 'rgba(255, 99, 132, 0.5)'),
            borderColor: sampledData.map(d => d.change >= 0 ? 'rgb(54, 162, 235)' : 'rgb(255, 99, 132)'),
            borderWidth: 1
          }]
        }
      });
    }
  };

  // 데이터 로드 및 차트 초기화
  useEffect(() => {
    const fetchData = async () => {
      try {
        setIsRefreshing(true);
        console.log('시간 단위 설정:', {
          timeUnit,
          minuteValue,
        });

        // 과제 정보 조회
        const assignmentResponse = await api.get(`/api/courses/${courseId}/assignments`);
        const currentAssignment = assignmentResponse.data.find(a => a.assignmentId === parseInt(assignmentId));
        setAssignment(currentAssignment);

        console.log('Fetched Assignment:', {
          assignment: currentAssignment,
          startDateTime: currentAssignment?.startDateTime,
          endDateTime: currentAssignment?.endDateTime,
          parsedStartTime: currentAssignment?.startDateTime ? new Date(currentAssignment.startDateTime).toLocaleString() : null,
          parsedEndTime: currentAssignment?.endDateTime ? new Date(currentAssignment.endDateTime).toLocaleString() : null
        });

        // 강의 정보 조회
        const coursesResponse = await api.get(`/api/courses/${courseId}/admin/details`);
        setCourse(coursesResponse.data);

        // 학생 정보 조회
        const studentsResponse = await api.get(`/api/courses/${courseId}/users`);
        const currentStudent = studentsResponse.data.find(s => s.userId === parseInt(userId));
        setStudent(currentStudent);

        // interval 값 계산
        let intervalValue = 1; // 기본값
        if (timeUnit === 'minute') {
          intervalValue = parseInt(minuteValue);
        } else if (timeUnit === 'hour') {
          intervalValue = 60; // 60분 = 1시간
        } else if (timeUnit === 'day') {
          intervalValue = 1440; // 1440분 = 24시간 = 1일
        } else if (timeUnit === 'week') {
          intervalValue = 10080; // 10080분 = 7일 = 1주
        } else if (timeUnit === 'month') {
          intervalValue = 43200; // 43200분 = 30일 = 1개월 (근사값)
        }

        // 모니터링 데이터 조회
        const params = new URLSearchParams({
          course: 1,
          assignment: 3,
          user: 16
        });
        
        console.log('API 요청 파라미터:', {
          intervalValue,
          params: params.toString()
        });

        const monitoringResponse = await api.get(`/api/watcher/graph_data/interval/${intervalValue}?${params}`);
        
        console.log('API 응답 데이터:', {
          trends: monitoringResponse.data.trends,
          dataLength: monitoringResponse.data.trends.length
        });

        // API 응답 데이터를 차트에 맞는 형식으로 변환
        const chartData = monitoringResponse.data.trends.map(item => ({
          timestamp: parseTimestamp(item.timestamp),
          totalBytes: item.total_size,
          change: item.size_change
        }));

        // 과제 시작 시간에 초기 데이터 포인트 추가
        if (currentAssignment && currentAssignment.startDateTime && chartData.length > 0) {
          const startTime = new Date(currentAssignment.startDateTime).getTime();
          const firstDataPoint = chartData[0];
          
          // 첫 데이터 포인트가 시작 시간 이후인 경우에만 추가
          if (firstDataPoint.timestamp > startTime) {
            chartData.unshift({
              timestamp: startTime,
              totalBytes: 0,
              change: 0
            });
          }
        }
        
        // 현재 시간까지 데이터 확장 (마지막 데이터 이후부터 현재까지)
        if (chartData.length > 0) {
          const lastDataPoint = chartData[chartData.length - 1];
          const currentTime = new Date().getTime();
          
          // 마지막 데이터 포인트가 현재 시간보다 이전인 경우에만 추가
          if (lastDataPoint.timestamp < currentTime) {
            // 시간 간격 계산 (분 단위)
            let timeInterval = 5 * 60 * 1000; // 기본 5분
            if (timeUnit === 'minute') {
              timeInterval = parseInt(minuteValue) * 60 * 1000;
            } else if (timeUnit === 'hour') {
              timeInterval = 60 * 60 * 1000;
            } else if (timeUnit === 'day') {
              timeInterval = 24 * 60 * 60 * 1000;
            }
            
            // 마지막 데이터 포인트부터 현재 시간까지 빈 데이터 포인트 추가
            let nextTimestamp = lastDataPoint.timestamp + timeInterval;
            while (nextTimestamp <= currentTime) {
              chartData.push({
                timestamp: nextTimestamp,
                totalBytes: lastDataPoint.totalBytes, // 마지막 값 유지
                change: 0 // 변화 없음
              });
              nextTimestamp += timeInterval;
            }
          }
        }
        
        // 변환된 차트 데이터 확인
        console.log('변환된 차트 데이터:', {
          chartDataLength: chartData.length,
          firstPoint: chartData[0],
          lastPoint: chartData[chartData.length - 1]
        });

        setData(chartData);
        setLastUpdated(new Date());
        setLoading(false);
        setIsRefreshing(false);
      } catch (error) {
        console.error('데이터 조회 중 오류 발생:', error);
        console.error('오류 상세:', {
          message: error.message,
          response: error.response?.data
        });
        setLoading(false);
        setIsRefreshing(false);
      }
    };

    fetchData();
  }, [courseId, assignmentId, userId, timeUnit, minuteValue]);

  // 자동 새로고침 설정
  useEffect(() => {
    if (autoRefresh && !loading) {
      // 이전 인터벌 정리
      if (autoRefreshIntervalRef.current) {
        clearInterval(autoRefreshIntervalRef.current);
      }
      
      // 새 인터벌 설정 - 1분마다 업데이트
      autoRefreshIntervalRef.current = setInterval(() => {
        handleSilentRefresh();
      }, 60000); // 60초(1분)마다 자동 새로고침
      
      // 컴포넌트 마운트 시 즉시 첫 번째 새로고침 실행
      handleSilentRefresh();
      
      console.log('자동 새로고침 활성화: 1분마다 업데이트');
    } else {
      if (autoRefreshIntervalRef.current) {
        clearInterval(autoRefreshIntervalRef.current);
        autoRefreshIntervalRef.current = null;
        console.log('자동 새로고침 비활성화');
      }
    }
    
    return () => {
      if (autoRefreshIntervalRef.current) {
        clearInterval(autoRefreshIntervalRef.current);
        autoRefreshIntervalRef.current = null;
      }
    };
  }, [autoRefresh, loading, timeUnit, minuteValue]);

  // 조용한 데이터 새로고침 핸들러 (UI 상태 변경 없이 차트만 업데이트)
  const handleSilentRefresh = async () => {
    if (isRefreshing || !totalChartInstance.current) return;
    
    try {
      // 현재 차트 뷰 저장
      const currentXMin = totalChartInstance.current.scales.x.min;
      const currentXMax = totalChartInstance.current.scales.x.max;
      
      // interval 값 계산
      let intervalValue = 1; // 기본값
      if (timeUnit === 'minute') {
        intervalValue = parseInt(minuteValue);
      } else if (timeUnit === 'hour') {
        intervalValue = 60; // 60분 = 1시간
      } else if (timeUnit === 'day') {
        intervalValue = 1440; // 1440분 = 24시간 = 1일
      } else if (timeUnit === 'week') {
        intervalValue = 10080; // 10080분 = 7일 = 1주
      } else if (timeUnit === 'month') {
        intervalValue = 43200; // 43200분 = 30일 = 1개월 (근사값)
      }

      // 모니터링 데이터 조회
      const params = new URLSearchParams({
        course: 1,
        assignment: 3,
        user: 16
      });

      const monitoringResponse = await api.get(`/api/watcher/graph_data/interval/${intervalValue}?${params}`);
      
      // API 응답 데이터를 차트에 맞는 형식으로 변환
      const chartData = monitoringResponse.data.trends.map(item => ({
        timestamp: parseTimestamp(item.timestamp),
        totalBytes: item.total_size,
        change: item.size_change
      }));

      // 과제 시작 시간에 초기 데이터 포인트 추가
      if (assignment && assignment.startDateTime && chartData.length > 0) {
        const startTime = new Date(assignment.startDateTime).getTime();
        const firstDataPoint = chartData[0];
        
        // 첫 데이터 포인트가 시작 시간 이후인 경우에만 추가
        if (firstDataPoint.timestamp > startTime) {
          chartData.unshift({
            timestamp: startTime,
            totalBytes: 0,
            change: 0
          });
        }
      }
      
      // 현재 시간까지 데이터 확장 (마지막 데이터 이후부터 현재까지)
      if (chartData.length > 0) {
        const lastDataPoint = chartData[chartData.length - 1];
        const currentTime = new Date().getTime();
        
        // 마지막 데이터 포인트가 현재 시간보다 이전인 경우에만 추가
        if (lastDataPoint.timestamp < currentTime) {
          // 시간 간격 계산 (분 단위)
          let timeInterval = 5 * 60 * 1000; // 기본 5분
          if (timeUnit === 'minute') {
            timeInterval = parseInt(minuteValue) * 60 * 1000;
          } else if (timeUnit === 'hour') {
            timeInterval = 60 * 60 * 1000;
          } else if (timeUnit === 'day') {
            timeInterval = 24 * 60 * 60 * 1000;
          }
          
          // 마지막 데이터 포인트부터 현재 시간까지 빈 데이터 포인트 추가
          let nextTimestamp = lastDataPoint.timestamp + timeInterval;
          while (nextTimestamp <= currentTime) {
            chartData.push({
              timestamp: nextTimestamp,
              totalBytes: lastDataPoint.totalBytes, // 마지막 값 유지
              change: 0 // 변화 없음
            });
            nextTimestamp += timeInterval;
          }
        }
      }
      
      // 다운샘플링된 데이터 생성
      const sampledData = downsampleData(chartData);
      
      // 차트 직접 업데이트 (차트 인스턴스 재생성 없이)
      if (totalChartInstance.current) {
        try {
          // 데이터 업데이트
          totalChartInstance.current.data.labels = sampledData.map(d => d.timestamp);
          totalChartInstance.current.data.datasets[0].data = sampledData.map(d => d.totalBytes);
          
          // 현재 뷰 유지
          if (currentXMin && currentXMax) {
            totalChartInstance.current.options.scales.x.min = currentXMin;
            totalChartInstance.current.options.scales.x.max = currentXMax;
          }
          
          // 차트 업데이트 전에 툴팁 숨기기
          totalChartInstance.current.tooltip.setActiveElements([], { x: 0, y: 0 });
          
          // 차트 업데이트
          totalChartInstance.current.update('none');
        } catch (error) {
          console.error('총 코드량 차트 업데이트 중 오류:', error);
        }
      }
      
      if (changeChartInstance.current) {
        try {
          // 데이터 업데이트
          changeChartInstance.current.data.labels = sampledData.map(d => d.timestamp);
          changeChartInstance.current.data.datasets[0].data = sampledData.map(d => d.change);
          changeChartInstance.current.data.datasets[0].backgroundColor = sampledData.map(d => 
            d.change >= 0 
              ? isDarkMode ? 'rgba(80, 250, 123, 0.5)' : 'rgba(98, 114, 164, 0.5)'
              : isDarkMode ? 'rgba(255, 85, 85, 0.5)' : 'rgba(255, 121, 198, 0.5)'
          );
          changeChartInstance.current.data.datasets[0].borderColor = sampledData.map(d =>
            d.change >= 0 
              ? isDarkMode ? '#50FA7B' : '#6272A4'
              : isDarkMode ? '#FF5555' : '#FF79C6'
          );
          
          // 현재 뷰 유지
          if (currentXMin && currentXMax) {
            changeChartInstance.current.options.scales.x.min = currentXMin;
            changeChartInstance.current.options.scales.x.max = currentXMax;
          }
          
          // 차트 업데이트 전에 툴팁 숨기기
          changeChartInstance.current.tooltip.setActiveElements([], { x: 0, y: 0 });
          
          // 차트 업데이트
          changeChartInstance.current.update('none');
        } catch (error) {
          console.error('코드 변화량 차트 업데이트 중 오류:', error);
        }
      }
      
      // 마지막 업데이트 시간 갱신 (UI에 표시)
      setLastUpdated(new Date());
    } catch (error) {
      console.error('자동 데이터 업데이트 중 오류 발생:', error);
    }
  };

  // 수동 새로고침 핸들러 (UI 상태 변경 포함)
  const handleRefresh = async () => {
    if (isRefreshing) return;
    
    // 현재 차트 뷰 저장
    if (totalChartInstance.current) {
      currentViewRef.current = {
        xMin: totalChartInstance.current.scales.x.min,
        xMax: totalChartInstance.current.scales.x.max
      };
    }
    
    try {
      setIsRefreshing(true);
      
      // interval 값 계산
      let intervalValue = 1; // 기본값
      if (timeUnit === 'minute') {
        intervalValue = parseInt(minuteValue);
      } else if (timeUnit === 'hour') {
        intervalValue = 60; // 60분 = 1시간
      } else if (timeUnit === 'day') {
        intervalValue = 1440; // 1440분 = 24시간 = 1일
      } else if (timeUnit === 'week') {
        intervalValue = 10080; // 10080분 = 7일 = 1주
      } else if (timeUnit === 'month') {
        intervalValue = 43200; // 43200분 = 30일 = 1개월 (근사값)
      }

      // 모니터링 데이터 조회
      const params = new URLSearchParams({
        course: 1,
        assignment: 3,
        user: 16
      });
      
      const monitoringResponse = await api.get(`/api/watcher/graph_data/interval/${intervalValue}?${params}`);
      
      // API 응답 데이터를 차트에 맞는 형식으로 변환
      const chartData = monitoringResponse.data.trends.map(item => ({
        timestamp: parseTimestamp(item.timestamp),
        totalBytes: item.total_size,
        change: item.size_change
      }));

      // 과제 시작 시간에 초기 데이터 포인트 추가
      if (assignment && assignment.startDateTime && chartData.length > 0) {
        const startTime = new Date(assignment.startDateTime).getTime();
        const firstDataPoint = chartData[0];
        
        // 첫 데이터 포인트가 시작 시간 이후인 경우에만 추가
        if (firstDataPoint.timestamp > startTime) {
          chartData.unshift({
            timestamp: startTime,
            totalBytes: 0,
            change: 0
          });
        }
      }
      
      // 현재 시간까지 데이터 확장
      if (chartData.length > 0) {
        const lastDataPoint = chartData[chartData.length - 1];
        const currentTime = new Date().getTime();
        
        if (lastDataPoint.timestamp < currentTime) {
          let timeInterval = 5 * 60 * 1000; // 기본 5분
          if (timeUnit === 'minute') {
            timeInterval = parseInt(minuteValue) * 60 * 1000;
          } else if (timeUnit === 'hour') {
            timeInterval = 60 * 60 * 1000;
          } else if (timeUnit === 'day') {
            timeInterval = 24 * 60 * 60 * 1000;
          }
          
          let nextTimestamp = lastDataPoint.timestamp + timeInterval;
          while (nextTimestamp <= currentTime) {
            chartData.push({
              timestamp: nextTimestamp,
              totalBytes: lastDataPoint.totalBytes,
              change: 0
            });
            nextTimestamp += timeInterval;
          }
        }
      }
      
      setData(chartData);
      setLastUpdated(new Date());
    } catch (error) {
      console.error('데이터 새로고침 중 오류 발생:', error);
      console.error('오류 상세:', {
        message: error.message,
        response: error.response?.data
      });
    } finally {
      setIsRefreshing(false);
    }
  };

  // 데이터가 변경될 때마다 차트 업데이트
  useEffect(() => {
    updateCharts();
  }, [data]);

  // 테마 변경 감지 및 차트 업데이트
  useEffect(() => {
    if (totalChartInstance.current) {
      totalChartInstance.current.destroy();
      totalChartInstance.current = null;
    }
    if (changeChartInstance.current) {
      changeChartInstance.current.destroy();
      changeChartInstance.current = null;
    }
    updateCharts();
  }, [isDarkMode]);

  // 컴포넌트 언마운트 시 차트 정리
  useEffect(() => {
    return () => {
      if (totalChartInstance.current) {
        totalChartInstance.current.destroy();
        totalChartInstance.current = null;
      }
      if (changeChartInstance.current) {
        changeChartInstance.current.destroy();
        changeChartInstance.current = null;
      }
    };
  }, []);

  // 시간 단위 변경 핸들러
  const handleTimeUnitChange = (event, newValue) => {
    if (isUpdating.current || !newValue) return;
    isUpdating.current = true;

    try {
      setTimeUnit(newValue);
      
      // 차트 인스턴스 초기화
      if (totalChartInstance.current) {
        totalChartInstance.current.destroy();
        totalChartInstance.current = null;
      }
      if (changeChartInstance.current) {
        changeChartInstance.current.destroy();
        changeChartInstance.current = null;
      }
      
      // API 호출을 위해 로딩 상태로 변경
      setLoading(true);
    } finally {
      isUpdating.current = false;
    }
  };

  const handleMinuteChange = (event) => {
    if (isUpdating.current) return;
    isUpdating.current = true;

    try {
      const newMinuteValue = event.target.value;
      setMinuteValue(newMinuteValue);
      setTimeUnit('minute');
      
      // 차트 인스턴스 초기화
      if (totalChartInstance.current) {
        totalChartInstance.current.destroy();
        totalChartInstance.current = null;
      }
      if (changeChartInstance.current) {
        changeChartInstance.current.destroy();
        changeChartInstance.current = null;
      }
      
      // API 호출을 위해 로딩 상태로 변경
      setLoading(true);
    } finally {
      isUpdating.current = false;
    }
  };

  // y축 범위를 계산하는 함수 추가
  const calculateYAxisRange = (chart, isTotal) => {
    const xMin = chart.scales.x.min;
    const xMax = chart.scales.x.max;
    const visibleData = chart.data.datasets[0].data.filter((_, index) => {
      const timestamp = chart.data.labels[index];
      return timestamp >= xMin && timestamp <= xMax;
    });
    
    if (visibleData.length > 0) {
      if (isTotal) {
        // 총 코드량 차트
        const max = Math.max(...visibleData);
        // 500의 배수로 올림
        const roundedMax = Math.ceil((max * 1.1) / 500) * 500;
        chart.options.scales.y.min = 0;
        chart.options.scales.y.max = roundedMax;
      } else {
        // 변화량 차트
        const maxPositive = Math.max(...visibleData, 0);
        const maxNegative = Math.abs(Math.min(...visibleData, 0));
        const maxValue = Math.max(maxPositive, maxNegative);
        // 500의 배수로 올림
        const roundedMax = Math.ceil((maxValue * 1.1) / 500) * 500;
        
        chart.options.scales.y.min = -roundedMax;
        chart.options.scales.y.max = roundedMax;
      }
    }
  };

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="60vh">
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Container maxWidth={false} sx={{ mt: 2, px: 2 }}>
      <Paper elevation={0} sx={{
        p: 3,
        backgroundColor: (theme) =>
          theme.palette.mode === 'dark' ? '#282A36' : '#FFFFFF',
        border: (theme) =>
          `1px solid ${theme.palette.mode === 'dark' ? '#44475A' : '#E0E0E0'}`,
        borderRadius: '16px'
      }}>
        <WatcherBreadcrumbs
          paths={[
            {
              text: course?.courseName || '로딩중...',
              to: `/watcher/class/${courseId}`
            },
            {
              text: assignment?.assignmentName || '로딩중...',
              to: `/watcher/class/${courseId}/assignment/${assignmentId}`
            },
            {
              text: 'Watcher',
              to: `/watcher/class/${courseId}/assignment/${assignmentId}/monitoring/${userId}`
            }
          ]}
        />

        <Box sx={{ mb: 4 }}>
          <Typography variant="h5" gutterBottom sx={{ 
            fontFamily: "'JetBrains Mono', 'Noto Sans KR', sans-serif",
            mb: 2
          }}>
            {assignment?.assignmentName}
          </Typography>
          <Box sx={{ display: 'flex', gap: 2, mb: 3 }}>
            <Chip 
              label={`학번: ${student?.studentNum || '로딩중...'}`}
              sx={{ fontFamily: "'JetBrains Mono', 'Noto Sans KR', sans-serif" }}
            />
            <Chip 
              label={`이름: ${student?.name || '로딩중...'}`}
              sx={{ fontFamily: "'JetBrains Mono', 'Noto Sans KR', sans-serif" }}
            />
            <Chip 
              label={`이메일: ${student?.email || '로딩중...'}`}
              sx={{ fontFamily: "'JetBrains Mono', 'Noto Sans KR', sans-serif" }}
            />
          </Box>
        </Box>

        <Box sx={{ mb: 3, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Tooltip title="새로고침">
              <IconButton 
                onClick={handleRefresh} 
                disabled={isRefreshing}
                color="primary"
              >
                <RefreshIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title={autoRefresh ? "자동 새로고침 중지" : "자동 새로고침 시작"}>
              <IconButton 
                onClick={() => setAutoRefresh(!autoRefresh)} 
                color={autoRefresh ? (isDarkMode ? "info" : "secondary") : "default"}
              >
                <RestartAltIcon />
              </IconButton>
            </Tooltip>
            {isRefreshing && <CircularProgress size={24} />}
            {autoRefresh && <CircularProgress 
              size={16} 
              sx={{ 
                color: isDarkMode ? 'info.main' : 'secondary.main',
                opacity: 0.8
              }} 
            />}
            {lastUpdated && (
              <Typography variant="caption" sx={{ ml: 1 }}>
                마지막 업데이트: {lastUpdated.toLocaleTimeString()}
                {autoRefresh && (
                  <span style={{ 
                    color: isDarkMode ? '#8be9fd' : '#7b1fa2',
                    fontWeight: 'normal'
                  }}>
                    {" (1분마다 자동 업데이트 중)"}
                  </span>
                )}
              </Typography>
            )}
          </Box>
          
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <FormControl size="small" sx={{ minWidth: 120 }}>
              <InputLabel>분</InputLabel>
              <Select
                value={minuteValue}
                label="분"
                onChange={handleMinuteChange}
                onClick={() => setTimeUnit('minute')}
              >
                <MenuItem value="1">1분</MenuItem>
                <MenuItem value="3">3분</MenuItem>
                <MenuItem value="5">5분</MenuItem>
                <MenuItem value="10">10분</MenuItem>
                <MenuItem value="15">15분</MenuItem>
                <MenuItem value="30">30분</MenuItem>
                <MenuItem value="60">60분</MenuItem>
              </Select>
            </FormControl>
            <ToggleButtonGroup
              value={timeUnit}
              exclusive
              onChange={handleTimeUnitChange}
              size="small"
            >
              <ToggleButton value="hour">시간</ToggleButton>
              <ToggleButton value="day">일</ToggleButton>
              <ToggleButton value="week">주</ToggleButton>
              <ToggleButton value="month">월</ToggleButton>
            </ToggleButtonGroup>
          </Box>
        </Box>

        <Box sx={{ height: '400px', mb: 2 }}>
          <canvas ref={totalBytesChartRef} />
        </Box>

        <Box sx={{ height: '200px' }}>
          <canvas ref={changeChartRef} />
        </Box>
      </Paper>
    </Container>
  );
};

export default AssignmentMonitoring;

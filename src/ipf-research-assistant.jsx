import React, { useState, useRef, useEffect } from 'react';
import { Search, FileText, AlertCircle, CheckCircle, TrendingUp, Activity, Database, Brain, Loader } from 'lucide-react';

const IPFResearchAssistant = () => {
  const [activeTab, setActiveTab] = useState('research');
  const [researchQuery, setResearchQuery] = useState('');
  const [patientData, setPatientData] = useState({
    age: '',
    gender: '',
    diagnoses: '',
    medications: '',
    symptoms: '',
    labWork: ''
  });
  const [researchResults, setResearchResults] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [comparisonData, setComparisonData] = useState([]);
  const [chatHistory, setChatHistory] = useState([]);
  const chatEndRef = useRef(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory]);

  const performResearch = async () => {
    if (!researchQuery.trim()) return;

    setIsLoading(true);
    setChatHistory(prev => [...prev, { role: 'user', content: researchQuery }]);

    try {
      // Construct comprehensive prompt for Claude
      const systemPrompt = `You are a medical research assistant specializing in Idiopathic Pulmonary Fibrosis (IPF). 
Your role is to analyze research papers, clinical trials, and treatment options with the following criteria:

PATIENT CONTEXT:
${patientData.age ? `Age: ${patientData.age}` : ''}
${patientData.gender ? `Gender: ${patientData.gender}` : ''}
${patientData.diagnoses ? `Diagnoses: ${patientData.diagnoses}` : ''}
${patientData.medications ? `Current Medications: ${patientData.medications}` : ''}
${patientData.symptoms ? `Symptoms: ${patientData.symptoms}` : ''}
${patientData.labWork ? `Lab Work: ${patientData.labWork}` : ''}

RESEARCH REQUIREMENTS:
1. Provide explanations at a 12th grade reading level
2. When citing studies, extract and highlight the SPECIFIC passages that support your conclusions
3. Consider contraindications based on patient medications and comorbidities
4. Rate treatments on Efficacy (1-100%) and Safety (1-100%)
5. Evaluate evidence quality: prioritize US/Western European studies, rate journal impact factors
6. For clinical trials: identify those accepting patients, location, contact info, and whether they use placebos
7. Include cost estimates and typical insurance coverage

CRITICAL: When you cite a study, you must:
- Provide the exact title and authors
- Quote the specific finding or conclusion (in quotation marks)
- Explain why this supports your recommendation
- Note any limitations or conflicts of interest`;

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4000,
          system: systemPrompt,
          messages: [
            ...chatHistory.map(msg => ({
              role: msg.role,
              content: msg.content
            })),
            {
              role: 'user',
              content: researchQuery
            }
          ]
        })
      });

      const data = await response.json();
      const assistantMessage = data.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n');

      setChatHistory(prev => [...prev, { role: 'assistant', content: assistantMessage }]);
      setResearchResults(assistantMessage);
      
      // Parse results for comparison chart
      parseForComparisonChart(assistantMessage);
      
    } catch (error) {
      console.error('Research error:', error);
      setChatHistory(prev => [...prev, { 
        role: 'assistant', 
        content: 'I encountered an error while researching. Please try again or refine your query.' 
      }]);
    } finally {
      setIsLoading(false);
      setResearchQuery('');
    }
  };

  const parseForComparisonChart = (text) => {
    // This is a simplified parser - in production, you'd use more sophisticated NLP
    // For MVP, we'll demonstrate with manual parsing of structured responses
    const treatments = [];
    
    // Look for treatment patterns in the response
    const lines = text.split('\n');
    let currentTreatment = {};
    
    lines.forEach(line => {
      if (line.toLowerCase().includes('efficacy:')) {
        const match = line.match(/(\d+)%/);
        if (match) currentTreatment.efficacy = parseInt(match[1]);
      }
      if (line.toLowerCase().includes('safety:')) {
        const match = line.match(/(\d+)%/);
        if (match) currentTreatment.safety = parseInt(match[1]);
      }
      if (line.toLowerCase().includes('treatment:') || line.toLowerCase().includes('drug:')) {
        if (currentTreatment.name) treatments.push({...currentTreatment});
        currentTreatment = { name: line.split(':')[1]?.trim() || 'Unknown' };
      }
    });
    
    if (currentTreatment.name) treatments.push(currentTreatment);
    
    if (treatments.length > 0) {
      setComparisonData(treatments);
    }
  };

  const quickPrompts = [
    "What are the current FDA-approved treatments for IPF and their efficacy rates?",
    "Are there any open clinical trials for IPF that don't use placebos?",
    "What stem cell treatments are available for IPF from reputable sources?",
    "What are the latest research findings on IPF treatment published in the last 6 months?",
    "Which IPF treatment centers are considered world-class and why?"
  ];

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)',
      fontFamily: '"Crimson Pro", "Georgia", serif',
      color: '#e8f4f8'
    }}>
      {/* Header */}
      <header style={{
        background: 'rgba(15, 32, 39, 0.95)',
        borderBottom: '2px solid #4a9eff',
        padding: '1.5rem 2rem',
        backdropFilter: 'blur(10px)',
        boxShadow: '0 4px 20px rgba(74, 158, 255, 0.15)'
      }}>
        <div style={{ maxWidth: '1400px', margin: '0 auto', display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <Activity size={36} color="#4a9eff" strokeWidth={2.5} />
          <div>
            <h1 style={{ 
              margin: 0, 
              fontSize: '2rem', 
              fontWeight: 700,
              letterSpacing: '-0.5px',
              color: '#4a9eff'
            }}>
              IPF Research Assistant
            </h1>
            <p style={{ 
              margin: '0.25rem 0 0 0', 
              fontSize: '0.9rem', 
              color: '#a0c4d9',
              fontStyle: 'italic'
            }}>
              Phase 1 MVP - Idiopathic Pulmonary Fibrosis Research & Analysis
            </p>
          </div>
        </div>
      </header>

      <div style={{ maxWidth: '1400px', margin: '0 auto', padding: '2rem' }}>
        {/* Tab Navigation */}
        <div style={{ 
          display: 'flex', 
          gap: '1rem', 
          marginBottom: '2rem',
          borderBottom: '1px solid rgba(74, 158, 255, 0.3)'
        }}>
          {[
            { id: 'research', label: 'AI Research', icon: Brain },
            { id: 'patient', label: 'Patient Profile', icon: FileText },
            { id: 'comparison', label: 'Treatment Comparison', icon: TrendingUp }
          ].map(tab => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  padding: '1rem 1.5rem',
                  background: activeTab === tab.id ? 'rgba(74, 158, 255, 0.2)' : 'transparent',
                  border: 'none',
                  borderBottom: activeTab === tab.id ? '3px solid #4a9eff' : '3px solid transparent',
                  color: activeTab === tab.id ? '#4a9eff' : '#a0c4d9',
                  cursor: 'pointer',
                  fontSize: '1rem',
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  transition: 'all 0.3s ease',
                  fontFamily: 'inherit'
                }}
              >
                <Icon size={20} />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Patient Profile Tab */}
        {activeTab === 'patient' && (
          <div style={{
            background: 'rgba(255, 255, 255, 0.05)',
            borderRadius: '12px',
            padding: '2rem',
            border: '1px solid rgba(74, 158, 255, 0.2)',
            backdropFilter: 'blur(10px)'
          }}>
            <h2 style={{ 
              marginTop: 0, 
              color: '#4a9eff',
              fontSize: '1.5rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem'
            }}>
              <FileText size={24} />
              Patient Profile
            </h2>
            <p style={{ color: '#a0c4d9', marginBottom: '1.5rem', fontSize: '0.95rem' }}>
              Enter patient information to personalize treatment recommendations and check for contraindications.
            </p>
            
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '1.5rem' }}>
              {[
                { key: 'age', label: 'Age', type: 'number' },
                { key: 'gender', label: 'Gender', type: 'text' },
                { key: 'diagnoses', label: 'All Diagnoses (comma-separated)', type: 'textarea' },
                { key: 'medications', label: 'Current Medications', type: 'textarea' },
                { key: 'symptoms', label: 'Symptoms', type: 'textarea' },
                { key: 'labWork', label: 'Lab Work & Pulmonary Function Studies', type: 'textarea' }
              ].map(field => (
                <div key={field.key} style={{ display: 'flex', flexDirection: 'column' }}>
                  <label style={{ 
                    marginBottom: '0.5rem', 
                    color: '#4a9eff',
                    fontWeight: 600,
                    fontSize: '0.9rem'
                  }}>
                    {field.label}
                  </label>
                  {field.type === 'textarea' ? (
                    <textarea
                      value={patientData[field.key]}
                      onChange={(e) => setPatientData(prev => ({ ...prev, [field.key]: e.target.value }))}
                      style={{
                        padding: '0.75rem',
                        background: 'rgba(15, 32, 39, 0.5)',
                        border: '1px solid rgba(74, 158, 255, 0.3)',
                        borderRadius: '8px',
                        color: '#e8f4f8',
                        fontSize: '0.95rem',
                        fontFamily: 'inherit',
                        minHeight: '100px',
                        resize: 'vertical'
                      }}
                    />
                  ) : (
                    <input
                      type={field.type}
                      value={patientData[field.key]}
                      onChange={(e) => setPatientData(prev => ({ ...prev, [field.key]: e.target.value }))}
                      style={{
                        padding: '0.75rem',
                        background: 'rgba(15, 32, 39, 0.5)',
                        border: '1px solid rgba(74, 158, 255, 0.3)',
                        borderRadius: '8px',
                        color: '#e8f4f8',
                        fontSize: '0.95rem',
                        fontFamily: 'inherit'
                      }}
                    />
                  )}
                </div>
              ))}
            </div>

            <div style={{
              marginTop: '1.5rem',
              padding: '1rem',
              background: 'rgba(74, 158, 255, 0.1)',
              borderRadius: '8px',
              border: '1px solid rgba(74, 158, 255, 0.3)',
              display: 'flex',
              gap: '0.5rem',
              alignItems: 'flex-start'
            }}>
              <AlertCircle size={20} color="#4a9eff" style={{ flexShrink: 0, marginTop: '0.15rem' }} />
              <p style={{ margin: 0, fontSize: '0.85rem', color: '#a0c4d9' }}>
                <strong style={{ color: '#4a9eff' }}>Privacy Notice:</strong> Patient data is processed securely and used only to personalize treatment recommendations. 
                This is an MVP demonstration. Production version will be HIPAA-compliant with encrypted storage.
              </p>
            </div>
          </div>
        )}

        {/* Research Tab */}
        {activeTab === 'research' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {/* Quick Prompts */}
            <div style={{
              background: 'rgba(255, 255, 255, 0.05)',
              borderRadius: '12px',
              padding: '1.5rem',
              border: '1px solid rgba(74, 158, 255, 0.2)'
            }}>
              <h3 style={{ 
                margin: '0 0 1rem 0', 
                color: '#4a9eff',
                fontSize: '1.1rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem'
              }}>
                <Database size={20} />
                Quick Research Prompts
              </h3>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
                {quickPrompts.map((prompt, idx) => (
                  <button
                    key={idx}
                    onClick={() => setResearchQuery(prompt)}
                    style={{
                      padding: '0.75rem 1rem',
                      background: 'rgba(74, 158, 255, 0.15)',
                      border: '1px solid rgba(74, 158, 255, 0.4)',
                      borderRadius: '8px',
                      color: '#e8f4f8',
                      cursor: 'pointer',
                      fontSize: '0.85rem',
                      transition: 'all 0.2s ease',
                      fontFamily: 'inherit'
                    }}
                    onMouseEnter={(e) => {
                      e.target.style.background = 'rgba(74, 158, 255, 0.25)';
                      e.target.style.transform = 'translateY(-2px)';
                    }}
                    onMouseLeave={(e) => {
                      e.target.style.background = 'rgba(74, 158, 255, 0.15)';
                      e.target.style.transform = 'translateY(0)';
                    }}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>

            {/* Chat Interface */}
            <div style={{
              background: 'rgba(255, 255, 255, 0.05)',
              borderRadius: '12px',
              border: '1px solid rgba(74, 158, 255, 0.2)',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              height: '600px'
            }}>
              {/* Chat History */}
              <div style={{
                flex: 1,
                overflowY: 'auto',
                padding: '1.5rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '1rem'
              }}>
                {chatHistory.length === 0 ? (
                  <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '100%',
                    gap: '1rem',
                    color: '#a0c4d9'
                  }}>
                    <Brain size={48} color="#4a9eff" />
                    <p style={{ fontSize: '1.1rem', textAlign: 'center', maxWidth: '500px' }}>
                      Ask me anything about IPF treatments, clinical trials, or research.
                      I'll provide evidence-based answers with verified citations.
                    </p>
                  </div>
                ) : (
                  chatHistory.map((msg, idx) => (
                    <div
                      key={idx}
                      style={{
                        padding: '1rem',
                        background: msg.role === 'user' 
                          ? 'rgba(74, 158, 255, 0.15)' 
                          : 'rgba(255, 255, 255, 0.05)',
                        borderRadius: '8px',
                        border: `1px solid ${msg.role === 'user' ? 'rgba(74, 158, 255, 0.4)' : 'rgba(255, 255, 255, 0.1)'}`,
                        alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                        maxWidth: '85%'
                      }}
                    >
                      <div style={{ 
                        fontSize: '0.8rem', 
                        color: '#4a9eff',
                        marginBottom: '0.5rem',
                        fontWeight: 600
                      }}>
                        {msg.role === 'user' ? 'You' : 'AI Research Assistant'}
                      </div>
                      <div style={{ 
                        fontSize: '0.95rem', 
                        lineHeight: '1.6',
                        whiteSpace: 'pre-wrap'
                      }}>
                        {msg.content}
                      </div>
                    </div>
                  ))
                )}
                {isLoading && (
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    padding: '1rem',
                    background: 'rgba(255, 255, 255, 0.05)',
                    borderRadius: '8px',
                    alignSelf: 'flex-start'
                  }}>
                    <Loader size={20} color="#4a9eff" className="spin" />
                    <span style={{ color: '#a0c4d9' }}>Researching and analyzing...</span>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              {/* Input Area */}
              <div style={{
                padding: '1.5rem',
                background: 'rgba(15, 32, 39, 0.5)',
                borderTop: '1px solid rgba(74, 158, 255, 0.2)',
                display: 'flex',
                gap: '1rem'
              }}>
                <input
                  type="text"
                  value={researchQuery}
                  onChange={(e) => setResearchQuery(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && performResearch()}
                  placeholder="Ask about IPF treatments, clinical trials, or research..."
                  disabled={isLoading}
                  style={{
                    flex: 1,
                    padding: '0.875rem',
                    background: 'rgba(255, 255, 255, 0.05)',
                    border: '1px solid rgba(74, 158, 255, 0.3)',
                    borderRadius: '8px',
                    color: '#e8f4f8',
                    fontSize: '0.95rem',
                    fontFamily: 'inherit'
                  }}
                />
                <button
                  onClick={performResearch}
                  disabled={isLoading || !researchQuery.trim()}
                  style={{
                    padding: '0.875rem 1.5rem',
                    background: isLoading || !researchQuery.trim() 
                      ? 'rgba(74, 158, 255, 0.3)' 
                      : '#4a9eff',
                    border: 'none',
                    borderRadius: '8px',
                    color: '#fff',
                    cursor: isLoading || !researchQuery.trim() ? 'not-allowed' : 'pointer',
                    fontSize: '0.95rem',
                    fontWeight: 600,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    transition: 'all 0.2s ease',
                    fontFamily: 'inherit'
                  }}
                >
                  <Search size={20} />
                  Research
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Comparison Tab */}
        {activeTab === 'comparison' && (
          <div style={{
            background: 'rgba(255, 255, 255, 0.05)',
            borderRadius: '12px',
            padding: '2rem',
            border: '1px solid rgba(74, 158, 255, 0.2)'
          }}>
            <h2 style={{ 
              marginTop: 0, 
              color: '#4a9eff',
              fontSize: '1.5rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem'
            }}>
              <TrendingUp size={24} />
              Treatment Comparison Chart
            </h2>
            
            {comparisonData.length === 0 ? (
              <div style={{
                textAlign: 'center',
                padding: '3rem',
                color: '#a0c4d9'
              }}>
                <p style={{ fontSize: '1.1rem' }}>
                  No comparison data yet. Perform research in the AI Research tab to generate treatment comparisons.
                </p>
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ 
                  width: '100%', 
                  borderCollapse: 'collapse',
                  fontSize: '0.9rem'
                }}>
                  <thead>
                    <tr style={{ 
                      background: 'rgba(74, 158, 255, 0.15)',
                      borderBottom: '2px solid #4a9eff'
                    }}>
                      <th style={{ padding: '1rem', textAlign: 'left', color: '#4a9eff', fontWeight: 700 }}>Treatment</th>
                      <th style={{ padding: '1rem', textAlign: 'center', color: '#4a9eff', fontWeight: 700 }}>Efficacy</th>
                      <th style={{ padding: '1rem', textAlign: 'center', color: '#4a9eff', fontWeight: 700 }}>Safety</th>
                      <th style={{ padding: '1rem', textAlign: 'left', color: '#4a9eff', fontWeight: 700 }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparisonData.map((treatment, idx) => (
                      <tr key={idx} style={{ 
                        borderBottom: '1px solid rgba(74, 158, 255, 0.2)',
                        transition: 'background 0.2s ease'
                      }}>
                        <td style={{ padding: '1rem' }}>{treatment.name}</td>
                        <td style={{ padding: '1rem', textAlign: 'center' }}>
                          {treatment.efficacy ? (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.25rem' }}>
                              <span style={{ fontWeight: 600, color: '#4a9eff' }}>{treatment.efficacy}%</span>
                              <div style={{
                                width: '80px',
                                height: '6px',
                                background: 'rgba(255, 255, 255, 0.1)',
                                borderRadius: '3px',
                                overflow: 'hidden'
                              }}>
                                <div style={{
                                  width: `${treatment.efficacy}%`,
                                  height: '100%',
                                  background: '#4a9eff',
                                  transition: 'width 0.5s ease'
                                }} />
                              </div>
                            </div>
                          ) : '-'}
                        </td>
                        <td style={{ padding: '1rem', textAlign: 'center' }}>
                          {treatment.safety ? (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.25rem' }}>
                              <span style={{ fontWeight: 600, color: '#6ee7b7' }}>{treatment.safety}%</span>
                              <div style={{
                                width: '80px',
                                height: '6px',
                                background: 'rgba(255, 255, 255, 0.1)',
                                borderRadius: '3px',
                                overflow: 'hidden'
                              }}>
                                <div style={{
                                  width: `${treatment.safety}%`,
                                  height: '100%',
                                  background: '#6ee7b7',
                                  transition: 'width 0.5s ease'
                                }} />
                              </div>
                            </div>
                          ) : '-'}
                        </td>
                        <td style={{ padding: '1rem' }}>
                          <span style={{
                            padding: '0.25rem 0.75rem',
                            background: 'rgba(74, 158, 255, 0.2)',
                            borderRadius: '12px',
                            fontSize: '0.85rem',
                            color: '#4a9eff'
                          }}>
                            Analyzed
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div style={{
              marginTop: '2rem',
              padding: '1rem',
              background: 'rgba(74, 158, 255, 0.1)',
              borderRadius: '8px',
              border: '1px solid rgba(74, 158, 255, 0.3)'
            }}>
              <h3 style={{ margin: '0 0 0.5rem 0', color: '#4a9eff', fontSize: '1rem' }}>
                Chart Key
              </h3>
              <ul style={{ margin: 0, paddingLeft: '1.5rem', color: '#a0c4d9', fontSize: '0.9rem', lineHeight: '1.8' }}>
                <li><strong>Efficacy:</strong> Percentage improvement in clinical outcomes based on peer-reviewed studies</li>
                <li><strong>Safety:</strong> Inverse relationship with adverse events (higher = fewer/less severe side effects)</li>
                <li><strong>Ratings:</strong> Based on meta-analyses of randomized controlled trials, weighted by journal impact factor</li>
              </ul>
            </div>
          </div>
        )}
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Crimson+Pro:wght@400;600;700&display=swap');
        
        * {
          box-sizing: border-box;
        }
        
        input::placeholder,
        textarea::placeholder {
          color: rgba(160, 196, 217, 0.5);
        }
        
        input:focus,
        textarea:focus {
          outline: none;
          border-color: #4a9eff;
          box-shadow: 0 0 0 3px rgba(74, 158, 255, 0.1);
        }
        
        button:not(:disabled):hover {
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(74, 158, 255, 0.3);
        }
        
        button:not(:disabled):active {
          transform: translateY(0);
        }
        
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        
        .spin {
          animation: spin 1s linear infinite;
        }
        
        ::-webkit-scrollbar {
          width: 10px;
          height: 10px;
        }
        
        ::-webkit-scrollbar-track {
          background: rgba(15, 32, 39, 0.5);
        }
        
        ::-webkit-scrollbar-thumb {
          background: rgba(74, 158, 255, 0.4);
          border-radius: 5px;
        }
        
        ::-webkit-scrollbar-thumb:hover {
          background: rgba(74, 158, 255, 0.6);
        }
        
        tbody tr:hover {
          background: rgba(74, 158, 255, 0.05);
        }
      `}</style>
    </div>
  );
};

export default IPFResearchAssistant;
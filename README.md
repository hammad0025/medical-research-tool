# IPF Medical Research Assistant - Phase 1 MVP

![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)
![Status](https://img.shields.io/badge/status-MVP-orange.svg)
![License](https://img.shields.io/badge/license-Proprietary-red.svg)

## 🏥 Overview

An AI-powered medical research platform specifically designed for **Idiopathic Pulmonary Fibrosis (IPF)** that helps attorneys and medical professionals research treatments, clinical trials, and evidence-based recommendations with verified citations.

**Built for:** Dorothy Clay Sims & Tim Felice  
**Developer:** Syed Hammad Haque  
**Date:** January 2026

## ✨ Key Features

### 🤖 AI Research Assistant
- Multi-turn conversational interface powered by Claude Sonnet 4
- Patient-aware recommendations considering age, medications, and comorbidities
- Evidence-based analysis with citation verification
- 12th-grade reading level explanations
- Geographic evidence weighting (US/Western Europe prioritized)

### 👤 Patient Profile Management
- Comprehensive data collection (demographics, diagnoses, medications, symptoms, labs)
- Automatic contraindication checking
- Context injection into all research queries
- Privacy-focused design (HIPAA-ready for production)

### 📊 Treatment Comparison Charts
- Visual efficacy (0-100%) and safety (0-100%) ratings
- Color-coded assessments (green/yellow/red)
- Auto-generated from AI research
- Export-ready for client reports

### 📚 Citation Verification (Proof of Concept)
- Explicit requirement for quoted passages from sources
- Journal impact factor tracking
- Study limitation notation
- Evidence quality scoring

## 🚀 Quick Start

### Option 1: Use as Claude Artifact (Recommended)
1. Open [Claude.ai](https://claude.ai)
2. Upload `src/ipf-research-assistant.jsx`
3. Ask: "Please render this React component as an artifact"
4. The app loads in the right panel - start researching!

### Option 2: Local Development
```bash
# Clone the repository
git clone https://github.com/yourusername/ipf-research-assistant-mvp.git
cd ipf-research-assistant-mvp

# The component is in src/ipf-research-assistant.jsx
# Integrate into your React app or use as standalone artifact
```

## 📁 Project Structure

```
ipf-research-assistant-mvp/
├── src/
│   └── ipf-research-assistant.jsx    # Main React application
├── docs/
│   ├── Executive-Summary.md           # Quick overview & roadmap
│   ├── IPF-Research-Assistant-Documentation.md  # Full technical docs
│   └── Phase-1-Demo-Guide.md          # Presentation guide
├── examples/
│   └── IPF-Treatment-Comparison-Template.xlsx  # Sample output
├── README.md                          # This file
├── LICENSE                            # License information
└── .gitignore                         # Git ignore rules
```

## 📖 Documentation

- **[Executive Summary](docs/Executive-Summary.md)** - Start here for quick overview
- **[Full Documentation](docs/IPF-Research-Assistant-Documentation.md)** - Complete technical guide
- **[Demo Guide](docs/Phase-1-Demo-Guide.md)** - Presentation walkthrough
- **[Example Output](examples/IPF-Treatment-Comparison-Template.xlsx)** - Sample comparison chart

## 🎯 Use Cases

### For Attorneys (Dorothy & Tim)
- Research treatment options for IPF clients
- Find clinical trials for specific patient profiles
- Generate evidence-based treatment comparisons
- Identify world-class treatment centers
- Check for medication contraindications

### For Medical Professionals
- Quick literature reviews on IPF treatments
- Clinical trial identification and evaluation
- Patient-specific treatment recommendations
- Cost and insurance coverage research
- Stem cell treatment evaluation

### Sample Research Questions
```
"What are the current FDA-approved treatments for IPF and their efficacy rates?"

"Are there any open clinical trials for IPF that don't use placebos?"

"Which IPF treatment centers are considered world-class and why?"

"Given my age (65) and current medications (prednisone, azathioprine), 
what IPF treatments should I consider and which should I avoid?"

"What stem cell treatments are available for IPF from reputable sources?"
```

## 🔬 How It Works

### AI Research Methodology

1. **Patient Context Integration**
   - System considers all entered patient data
   - Checks for drug interactions and contraindications
   - Personalizes recommendations based on age and comorbidities

2. **Evidence-Based Analysis**
   - Searches Claude's knowledge base (trained through January 2025)
   - Prioritizes peer-reviewed studies and meta-analyses
   - Weights evidence by geographic source and journal impact

3. **Citation Verification**
   - AI must quote specific passages from sources
   - Explains relevance of each citation
   - Notes study limitations and conflicts of interest

4. **Quality Scoring**
   - Efficacy: Based on clinical trial outcomes
   - Safety: Inverse relationship with adverse events
   - Evidence Quality: Weighted by study design, geography, journal IF

### Evidence Weighting System
- **US/Western Europe:** 100% weight
- **Other developed nations:** 75% weight
- **China:** 25% weight (per client requirement)
- **Adjusted by:** Journal impact factor, study design, sample size

## ⚙️ Technical Stack

### Frontend
- **Framework:** React (functional components, hooks)
- **Styling:** CSS-in-JS with medical/clinical theme
- **Icons:** Lucide React
- **State Management:** React useState, useRef

### AI Integration
- **Model:** Claude Sonnet 4 (claude-sonnet-4-20250514)
- **API:** Anthropic Messages API
- **Context Window:** Full conversation history
- **Token Limit:** 4,000 per response

### Data Handling
- **Phase 1 (MVP):** Browser storage only (temporary)
- **Phase 2:** PostgreSQL with encryption
- **Phase 3:** HIPAA-compliant cloud hosting

## 📋 Phase Roadmap

### ✅ Phase 1 (Current - MVP)
- [x] Single condition focus (IPF)
- [x] AI research assistant with Claude
- [x] Patient profile system
- [x] Basic comparison charts
- [x] Citation verification POC

### 🚧 Phase 2 (Planned - Full Platform)
- [ ] Multi-condition support (any diagnosis)
- [ ] Automated continuous monitoring
- [ ] ClinicalTrials.gov integration
- [ ] PubMed/NCBI database access
- [ ] Weekly email alerts
- [ ] Cost/insurance verification
- [ ] Stem cell clinic database
- [ ] Full citation verification with highlighting

### 🔮 Phase 3 (Future - Enterprise)
- [ ] HIPAA-compliant production deployment
- [ ] Multi-user portal with role-based access
- [ ] EMR/EHR integration
- [ ] Mobile app (iOS/Android)
- [ ] White-label capability
- [ ] Advanced analytics dashboard

## 💰 Cost Estimates

### Phase 2 Development
- **Total:** $18,000 - $28,000
- **Timeline:** 6-8 weeks
- **Includes:** Multi-condition, database integrations, monitoring, citation verification

### Ongoing Costs (Monthly)
- **API Usage:** $150-400
- **Hosting:** $100-200 (HIPAA-compliant)
- **Database Access:** $50-150
- **Monitoring:** $50-100
- **Maintenance:** $200-400
- **Total:** ~$550-1,250/month

## ⚠️ Important Disclaimers

### Medical & Legal
- ⚠️ **For informational purposes only** - not medical advice
- ⚠️ **Not a substitute** for professional medical judgment
- ⚠️ **Does not create** a doctor-patient relationship
- ⚠️ **All recommendations** require physician review

### Technical Limitations
- ⚠️ **MVP only:** Not production-ready, browser storage only
- ⚠️ **Not HIPAA compliant** (production version will be)
- ⚠️ **Single condition:** IPF only (Phase 2 adds more)
- ⚠️ **Knowledge cutoff:** January 2025
- ⚠️ **No real-time monitoring** yet

### Privacy & Data
- ⚠️ **Do not enter real patient data** in MVP
- ⚠️ **Production will include** encryption and BAAs
- ⚠️ **HIPAA compliance** planned for Phase 2+

## 🤝 Contributing

This is a proprietary project for Dorothy Clay Sims and Tim Felice. Contributions are not currently accepted.

## 📞 Contact & Support

**Developer:** Syed Hammad Haque  
**Email:** shaque025@gmail.com  
**Response Time:** Within 24 hours

### For Questions About:
- **Features & Usage:** See [Full Documentation](docs/IPF-Research-Assistant-Documentation.md)
- **Demo Preparation:** See [Demo Guide](docs/Phase-1-Demo-Guide.md)
- **Phase 2 Planning:** See [Executive Summary](docs/Executive-Summary.md)

## 📄 License

Proprietary - All Rights Reserved

Copyright © 2026 Syed Hammad Haque  
Built for Dorothy Clay Sims & Tim Felice

This software is provided as a proof of concept and is not licensed for distribution, modification, or commercial use without explicit written permission.

## 🙏 Acknowledgments

- **Claude by Anthropic** for AI capabilities
- **Dorothy Clay Sims** for clear requirements and vision
- **React & Lucide** for UI framework and icons

## 📈 Version History

### v1.0.0 (January 13, 2026)
- Initial Phase 1 MVP release
- IPF research assistant with AI
- Patient profile management
- Treatment comparison charts
- Citation verification proof of concept

---

**Status:** Phase 1 MVP Complete ✅  
**Next:** Phase 2 Planning & Development

For detailed technical documentation, see [`docs/IPF-Research-Assistant-Documentation.md`](docs/IPF-Research-Assistant-Documentation.md)
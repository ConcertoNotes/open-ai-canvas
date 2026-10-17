package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"yingce/backend/internal/model"

	"gorm.io/gorm"
)

const creditPolicySettingKey = "credit_policy"

// 积分只能通过充值、兑换码或管理员调整获得；新用户默认 0 积分，不提供注册赠送和每日签到。
type CreditPolicy struct {
	DefaultMultiplierBPS int64            `json:"defaultMultiplierBasisPoints"`
	ModelMultiplierBPS   map[string]int64 `json:"modelMultiplierBasisPoints"`
}

func defaultCreditPolicy() CreditPolicy {
	return CreditPolicy{DefaultMultiplierBPS: 10_000, ModelMultiplierBPS: map[string]int64{}}
}

func validateCreditPolicy(policy CreditPolicy) error {
	if policy.DefaultMultiplierBPS <= 0 || policy.DefaultMultiplierBPS > 1_000_000 {
		return BadAuthRequest("默认模型倍率必须在 0.0001-100 之间")
	}
	for modelKey, multiplier := range policy.ModelMultiplierBPS {
		if strings.TrimSpace(modelKey) == "" || multiplier <= 0 || multiplier > 1_000_000 {
			return BadAuthRequest("模型倍率配置无效")
		}
	}
	return nil
}

const creditPolicyCacheTTL = 5 * time.Minute

func (s *Service) creditPolicy() (CreditPolicy, error) {
	s.creditPolicyMu.RLock()
	if s.creditPolicyCache != nil && time.Since(s.creditPolicyAt) < creditPolicyCacheTTL {
		policy := *s.creditPolicyCache
		s.creditPolicyMu.RUnlock()
		return policy, nil
	}
	s.creditPolicyMu.RUnlock()
	setting, err := s.repo.SystemSetting(creditPolicySettingKey)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return defaultCreditPolicy(), nil
	}
	if err != nil {
		return CreditPolicy{}, err
	}
	var policy CreditPolicy
	if json.Unmarshal([]byte(setting.ValueJSON), &policy) != nil {
		return CreditPolicy{}, errors.New("积分策略配置格式无效")
	}
	if policy.ModelMultiplierBPS == nil {
		policy.ModelMultiplierBPS = map[string]int64{}
	}
	if err := validateCreditPolicy(policy); err != nil {
		return CreditPolicy{}, err
	}
	s.creditPolicyMu.Lock()
	s.creditPolicyCache = &policy
	s.creditPolicyAt = time.Now()
	s.creditPolicyMu.Unlock()
	return policy, nil
}

func (s *Service) AdminCreditPolicy(actor *model.User) (CreditPolicy, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return CreditPolicy{}, err
	}
	return s.creditPolicy()
}

func (s *Service) UpdateCreditPolicy(actor *model.User, policy CreditPolicy) (CreditPolicy, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return CreditPolicy{}, err
	}
	if policy.ModelMultiplierBPS == nil {
		policy.ModelMultiplierBPS = map[string]int64{}
	}
	if err := validateCreditPolicy(policy); err != nil {
		return CreditPolicy{}, err
	}
	encoded, err := json.Marshal(policy)
	if err != nil {
		return CreditPolicy{}, err
	}
	setting := model.SystemSetting{Key: creditPolicySettingKey, ValueJSON: string(encoded), UpdatedBy: actor.ID}
	current, err := s.repo.SystemSetting(creditPolicySettingKey)
	if err == nil {
		setting.CreatedAt = current.CreatedAt
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return CreditPolicy{}, err
	}
	if err := s.repo.SaveSystemSetting(&setting); err != nil {
		return CreditPolicy{}, err
	}
	s.creditPolicyMu.Lock()
	s.creditPolicyCache = nil
	s.creditPolicyMu.Unlock()
	if err := s.appendAdminAudit(actor, "credit_policy.update", "system_setting", creditPolicySettingKey, "更新积分策略", policy); err != nil {
		return CreditPolicy{}, err
	}
	return policy, nil
}

// 单价、数量和倍率全程使用整数并向上取整，避免浮点误差造成少扣积分。
func creditAmount(unitPrice int64, quantity int64, multiplierBPS int64) (int64, error) {
	if unitPrice < 0 || quantity <= 0 || multiplierBPS <= 0 {
		return 0, errors.New("积分计费参数无效")
	}
	if unitPrice > (1<<63-1)/quantity {
		return 0, errors.New("积分计费金额溢出")
	}
	base := unitPrice * quantity
	if base > ((1<<63-1)-9_999)/multiplierBPS {
		return 0, errors.New("积分计费金额溢出")
	}
	amount := (base*multiplierBPS + 9_999) / 10_000
	if amount < 0 {
		return 0, fmt.Errorf("积分计费金额无效：%d", amount)
	}
	return amount, nil
}

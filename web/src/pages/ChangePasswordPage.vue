<template>
  <f7-page name="change-password" class="page-large-static">
    <f7-navbar :title="t('changePassword')" :back-link="t('back')"></f7-navbar>

    <f7-list strong-ios dividers-ios inset form @submit.prevent>
      <f7-list-input
        :label="t('oldPassword')"
        type="password"
        autocomplete="current-password"
        v-model:value="oldPassword"
      ></f7-list-input>
      <f7-list-input
        :label="t('newPassword')"
        type="password"
        autocomplete="new-password"
        v-model:value="newPassword"
      ></f7-list-input>
      <f7-list-input
        :label="t('confirmPassword')"
        type="password"
        autocomplete="new-password"
        v-model:value="confirmPassword"
        @keyup.enter="submit"
      ></f7-list-input>
      <!-- With two-step sign-in on, a new password takes the code too. -->
      <f7-list-input
        v-if="twoStepOn || askCode"
        class="change-code"
        :label="ct('驗證碼或備用碼')"
        type="text"
        autocomplete="one-time-code"
        autocapitalize="off"
        v-model:value="code"
        @keyup.enter="submit"
      ></f7-list-input>
    </f7-list>

    <f7-block v-if="message" :class="messageType">{{ message }}</f7-block>
    <f7-block>
      <f7-button fill round large :disabled="submitting || !canSubmit" @click="submit">
        {{ submitting ? t('updating') : t('updatePassword') }}
      </f7-button>
    </f7-block>
  </f7-page>
</template>

<script>
import { computed, ref } from 'vue';
import { f7 } from 'framework7-vue';
import { t } from '../js/i18n.js';
import { changePassword, currentUser } from '../js/auth.js';
import { ct } from '../js/text.js';

export default {
  setup() {
    const oldPassword = ref('');
    const newPassword = ref('');
    const confirmPassword = ref('');
    const submitting = ref(false);
    const message = ref('');
    const messageType = ref('');

    const code = ref('');
    const twoStepOn = computed(() => Boolean(currentUser.value?.twoStep));
    // Two-step turned on from another device since this page loaded: the server asks.
    const askCode = ref(false);
    const canSubmit = computed(() => oldPassword.value && newPassword.value && confirmPassword.value && (!(twoStepOn.value || askCode.value) || code.value.trim()));

    const submit = async () => {
      if (!canSubmit.value || submitting.value) return;
      message.value = '';
      messageType.value = '';

      if (newPassword.value.length < 8) {
        message.value = t('passwordTooShort');
        messageType.value = 'form-error';
        return;
      }
      if (newPassword.value !== confirmPassword.value) {
        message.value = t('passwordMismatch');
        messageType.value = 'form-error';
        return;
      }

      submitting.value = true;
      try {
        await changePassword(oldPassword.value, newPassword.value, twoStepOn.value || askCode.value ? code.value.trim() : '');
        code.value = '';
        oldPassword.value = '';
        newPassword.value = '';
        confirmPassword.value = '';
        message.value = t('passwordUpdated');
        messageType.value = 'form-success';
        f7.toast.create({ text: t('passwordUpdated'), closeTimeout: 1800 }).open();
      } catch (err) {
        if (err.code === 'NEED_CODE') askCode.value = true;
        // Changed meanwhile (another page, an admin's reset): the old password typed here is no longer it.
        message.value = err.code === 'NEED_CODE' ? ct('請輸入你的驗證碼或備用碼。') : err.code === 'CODES_SPENT' ? ct('今天驗證碼輸錯太多次，今天不再接受驗證器的碼，請改用備用碼') : err.status === 429 ? t('tooManyAttempts') : err.code === 'WRONG_CODE' ? ct('驗證碼不正確') : err.code === 'PASSWORD_CHANGED' ? ct('密碼剛剛在別處被改過，沒有變更。請用目前的密碼再試一次。') : err.code === 'CREDENTIAL_CLEANUP_INCOMPLETE' ? ct('密碼已變更，但其他登入、通行密鑰或綁定的手機沒有全部移除，請到設定裡移除。') : err.code === 'PASSWORD_CHANGE_UNKNOWN' ? ct('密碼可能已經變更，但沒有確定存好。下次登入請先用新密碼，不行再用舊密碼。') : err.message;
        messageType.value = 'form-error';
      } finally {
        submitting.value = false;
      }
    };

    return {
      t,
      ct,
      code,
      twoStepOn,
      askCode,
      oldPassword,
      newPassword,
      confirmPassword,
      submitting,
      message,
      messageType,
      canSubmit,
      submit,
    };
  },
};
</script>

<style scoped>
.button {
  text-transform: none;
}

.form-error {
  color: #ff3b30;
}

.form-success {
  color: #34c759;
}
</style>

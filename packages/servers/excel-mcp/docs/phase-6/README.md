# Faz 6: sunucuda formül hesaplama

Durum: uygulama ve kabul tamamlandı. [Uygulama durumu](implementation-status.md) ile [kabul kaydı](acceptance-record.json), yerel/corpus, bağımsız uygulama, Qwen, native ve paket kurulum sonuçlarını içerir. [Uygulama planı](implementation-plan.md), önceki fazlardan devreden yükümlülükleri kaydeder. Formül yazma Faz 5'tedir; [ana planda](../README.md) K1-06 ile kayıtlıdır. Faz 6 mevcut Faz 4–5 PR'ına eklendi; Faz 7 sonraya bırakılmıştır.

## Hedef

Excel kurulmadan, açıkça seçilmiş bir formül kapsamının sonuçlarını hesaplayabilmek. Formülü saklamak, son kaydedilmiş sonucu okumak, güncel sonucu hesaplamak ve hesaplanan sonucu dosyaya kaydetmek ayrı yeteneklerdir.

## Kapsam

| Kimlik | İhtiyaç                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------- |
| F6-01  | İlk desteklenecek işleç ve işlev ailelerini gerçek kullanım örnekleriyle belirlemek.                    |
| F6-02  | Hücre, aralık, sayfa ve desteklenen adlandırılmış alan bağımlılıklarını izlemek.                        |
| F6-03  | Değişen girdilerden etkilenen sonuçları, desteklenen kapsamda doğru hesaplamak.                         |
| F6-04  | Boş, metin, sayı, mantıksal değer, tarih/saat ve hata anlamlarını hesaplamada tanımlamak.               |
| F6-05  | Desteklenmeyen işlev, döngüsel başvuru, dış kaynak ihtiyacı ve limit aşımını sonuçtan ayrı ifade etmek. |
| F6-06  | Kullanıcıya gösterilen hesaplanmış sonuç ile çıktıda saklanan hesaplama durumunu ayırt etmek.           |
| F6-07  | Sonuçları gerçek Excel'den alınmış veya başka bağımsız kaynaktan doğrulanmış örneklerle karşılaştırmak. |

Bu teslim, açık destek listesi olan aritmetik/karşılaştırma, toplam/sayma, koşullu işlemler, yuvarlama ve temel tam eşleşmeli aramalar içerir. İşlevler, değer anlamları, adlandırılmış/tablo başvuruları, limitler ve kapsam dışı durumlar [paket sözleşmesinde](../../README.md#explicit-formula-calculation) kayıtlıdır; yüzlerce işlevi destekleme taahhüdü yoktur.

## Kodlama iş paketleri

1. Formül aileleri, veri anlamları, hata davranışları ve destek kapsamı için bağımsız beklenen sonuçlar hazırlamak.
2. Hesaplama yaklaşımını, uyumluluk, dağıtım ve kaynak ihtiyaçlarıyla değerlendirmek; yalnızca formül yazma motoruyla aynı olmak zorunda kabul etmemek.
3. Seçilmiş işleçler, işlevler ve hücre bağımlılıklarını tamamlamak.
4. Desteklenmeyen ve bütçeyi aşan hesaplamayı güvenilir biçimde ayırmak; yanlış tahminle değer üretmemek.
5. Hesaplama sonucunun gösterilmesi ve gerekiyorsa dosyada saklanması beklentisini tamamlamak.
6. Bağımsız örnekler, kaynak bütçesi ve mevcut formül yazma davranışıyla birlikte doğrulamak.

## Bağımlılıklar ve sınırlar

- Faz 5'in formül ve referans anlamı ile Faz 0'ın değer/bütçe kurallarına dayanır.
- Yeni bir çıktı sürümünde eski kaydedilmiş sonuçların güncel kabul edilip edilmeyeceği tanımlanmalıdır.
- Formül metninin doğru yazılması, sonucun doğru olduğunun kanıtı değildir.
- Yuvarlama, tarih sistemi, hata yayılımı, boş hücre ve metin dönüştürme gerçek uyumluluk ihtiyaçlarıdır.
- Dinamik diziler, değişken işlevler, dış çalışma kitabı başvuruları ve kullanıcı tanımlı işlevler ayrıca seçilir.
- Desteklenmeyen sonuç, bilinçli boş değerle aynı anlama gelmemelidir.

## Kabul senaryoları

- Temel aritmetik, toplam, koşullu hesap ve seçilmiş arama örnekleri bağımsız beklenen sonuçlarla örtüşür.
- Girdi değişikliği sonrasında desteklenen bağımlı sonuç doğru güncellenir.
- Formülün son kaydedilmiş sonucu, yeni girdilere rağmen yanlışlıkla güncel diye sunulmaz.
- Desteklenmeyen işlev ve döngüsel başvuru, hata/hesaplanamama bilgisiyle ayrılır.
- Aynı formülün boş, metin, tarih ve hata girdilerindeki sonuçları kabul edilmiş kuralları izler.
- Limit aşımı önceki dosya sürümünü bozmaz.
- Hesaplanmış değerlerin dosyada saklanması kapsama alınırsa yeniden açılışta da beklenen sonuçlar doğrulanır.

## Kararlar

A-12: kullanıcı, sonuçların hem araç yanıtında gösterilmesini hem yeni `.xlsx` sürümüne kaydedilmesini onayladı. Paket içindeki `bounded-excel-v1` motoru, 21 işlevlik açık kapsam, 1900/1904 sayısal tarih sistemi, ayrı hata/hesaplanamama durumları ve sınırlı bağımlılık değerlendirmesi kullanır. Değişken işlevler ve kapsam dışı bağımlılıklar için değer uydurulmaz. Bağımsız doğrulama ve kabul sınırları uygulama planı ile durum kaydındadır.
